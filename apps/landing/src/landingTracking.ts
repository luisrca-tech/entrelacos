// Consent-gated Meta Pixel and GA4 for the marketing landing only.
// Couple sites, demos and the admin must never load these trackers.

export const consentStorageKey = "entrelacos-tracking-consent";
const refStorageKey = "entrelacos-contact-ref";

type Environment = Record<string, string | undefined>;

export interface TrackingIds {
  metaPixelId?: string;
  ga4Id?: string;
}

export interface ClickDestinations {
  botanicalUrl: string;
  lettersUrl: string;
  contactUrl: string;
}

export type TrackingSettings = TrackingIds & ClickDestinations;

export type TrackedClick =
  | { kind: "demo"; contentName: "Cinema Botânico" | "Cartas do Nosso Sim" }
  | { kind: "contact"; contentName: string };

type Consent = "granted" | "denied";

type Fbq = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  queue: unknown[];
  push?: Fbq;
  loaded: boolean;
  version: string;
};

type TrackingWindow = Window & {
  fbq?: Fbq;
  _fbq?: Fbq;
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
};

/** Optional, public identifiers. Blank means disabled; a typo fails the build. */
export function trackingIds(env: Environment): TrackingIds {
  const ids: TrackingIds = {};
  const pixel = env.PUBLIC_META_PIXEL_ID?.trim();
  if (pixel) {
    if (!/^\d{5,20}$/.test(pixel))
      throw new Error("PUBLIC_META_PIXEL_ID must contain only digits.");
    ids.metaPixelId = pixel;
  }
  const ga4 = env.PUBLIC_GA4_MEASUREMENT_ID?.trim();
  if (ga4) {
    if (!/^G-[A-Z0-9]{4,20}$/.test(ga4))
      throw new Error("PUBLIC_GA4_MEASUREMENT_ID must look like G-XXXXXXX.");
    ids.ga4Id = ga4;
  }
  return ids;
}

function pageAddress(href: string): string | null {
  try {
    const url = new URL(href);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

/** Demo links match by origin and path, so the mural fragment still counts. */
export function classifyClick(
  href: string,
  position: string,
  destinations: ClickDestinations,
): TrackedClick | null {
  const address = pageAddress(href);
  if (!address) return null;
  if (address === pageAddress(destinations.botanicalUrl))
    return { kind: "demo", contentName: "Cinema Botânico" };
  if (address === pageAddress(destinations.lettersUrl))
    return { kind: "demo", contentName: "Cartas do Nosso Sim" };
  if (address === pageAddress(destinations.contactUrl))
    return { kind: "contact", contentName: position };
  return null;
}

function slug(value: string | null, length: number): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, length)
    .replace(/-+$/, "");
}

const sourceCodes: Record<string, string> = {
  instagram: "ig",
  ig: "ig",
  facebook: "fb",
  fb: "fb",
};

/** Short code such as `ig-verao`, or null when the visit has no ad markers. */
export function contactRef(search: string): string | null {
  const params = new URLSearchParams(search);
  const source = slug(params.get("utm_source"), 20);
  const campaign = slug(params.get("utm_campaign"), 40);
  const clicked = params.has("fbclid");
  if (!source && !campaign && !clicked) return null;
  const origin = sourceCodes[source] ?? (source || (clicked ? "meta" : "ads"));
  return campaign ? `${origin}-${campaign}` : origin;
}

export function withContactRef(contactUrl: string, ref: string | null): string {
  if (!ref) return contactUrl;
  const url = new URL(contactUrl);
  if (url.hostname !== "wa.me") return contactUrl;
  const text = url.searchParams.get("text");
  url.searchParams.set("text", `${text ? `${text} ` : ""}(ref: ${ref})`);
  // Keep %20 like the original link; a literal "+" is already encoded as %2B.
  url.search = url.searchParams.toString().replace(/\+/g, "%20");
  return url.href;
}

function read(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function write(storage: () => Storage, key: string, value: string) {
  try {
    storage().setItem(key, value);
  } catch {
    // Private modes may block storage; the choice then lasts for this page.
  }
}

function addScript(doc: Document, src: string) {
  const script = doc.createElement("script");
  script.async = true;
  script.src = src;
  doc.head.append(script);
}

// Equivalent to Meta's official base code, without inline script injection.
function loadMetaPixel(doc: Document, browser: TrackingWindow, id: string) {
  if (!browser.fbq) {
    const fbq = function (this: unknown, ...args: unknown[]) {
      if (fbq.callMethod) fbq.callMethod(...args);
      else fbq.queue.push(args);
    } as Fbq;
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = "2.0";
    fbq.queue = [];
    browser.fbq = fbq;
    browser._fbq ??= fbq;
    addScript(doc, "https://connect.facebook.net/en_US/fbevents.js");
  }
  browser.fbq("init", id);
  browser.fbq("track", "PageView");
}

// Equivalent to Google's gtag.js snippet; `config` sends the page_view.
function loadGa4(doc: Document, browser: TrackingWindow, id: string) {
  if (!browser.gtag) {
    browser.dataLayer ??= [];
    const dataLayer = browser.dataLayer;
    browser.gtag = function gtag() {
      // biome-ignore lint/complexity/noArguments: gtag.js reads Arguments objects, not arrays.
      dataLayer.push(arguments);
    };
    addScript(
      doc,
      `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`,
    );
    browser.gtag("js", new Date());
  }
  browser.gtag("config", id);
}

export function mountLandingTracking(
  doc: Document,
  browser: Window,
  settings: TrackingSettings,
): () => void {
  const win = browser as TrackingWindow;
  const listeners = new AbortController();
  const { signal } = listeners;

  // The ad reference is part of the visitor's own message, not tracking.
  const ref =
    contactRef(browser.location.search) ??
    read(() => browser.sessionStorage, refStorageKey);
  if (ref) {
    write(() => browser.sessionStorage, refStorageKey, ref);
    const target = pageAddress(settings.contactUrl);
    for (const link of doc.querySelectorAll<HTMLAnchorElement>("a[href]"))
      if (pageAddress(link.href) === target)
        link.href = withContactRef(link.href, ref);
  }

  const { metaPixelId, ga4Id } = settings;
  if (!metaPixelId && !ga4Id) return () => listeners.abort();

  let loaded = false;
  function load() {
    if (loaded) return;
    loaded = true;
    if (metaPixelId) loadMetaPixel(doc, win, metaPixelId);
    if (ga4Id) loadGa4(doc, win, ga4Id);
  }

  // Capture phase: record the click before any handler or navigation runs.
  doc.addEventListener(
    "click",
    (event) => {
      if (!loaded || !(event.target instanceof Element)) return;
      const link = event.target.closest<HTMLAnchorElement>("a[href]");
      if (!link) return;
      const position =
        link.closest<HTMLElement>("[data-track-position]")?.dataset
          .trackPosition ?? "outro";
      const click = classifyClick(link.href, position, settings);
      if (!click) return;
      const params = { content_name: click.contentName };
      if (metaPixelId)
        win.fbq?.(
          "track",
          click.kind === "demo" ? "ViewContent" : "Contact",
          params,
        );
      if (ga4Id)
        win.gtag?.(
          "event",
          click.kind === "demo" ? "view_demo" : "contact_whatsapp",
          params,
        );
    },
    { capture: true, signal },
  );

  const notice = doc.querySelector<HTMLElement>(".consent-notice");
  const choice = read(() => browser.localStorage, consentStorageKey);
  if (choice === "granted") load();
  else if (choice !== "denied" && notice) {
    notice.hidden = false;
    notice.addEventListener(
      "click",
      (event) => {
        const button =
          event.target instanceof Element &&
          event.target.closest<HTMLButtonElement>("button[data-consent]");
        if (!button) return;
        const consent = button.dataset.consent as Consent;
        write(() => browser.localStorage, consentStorageKey, consent);
        const hadFocus = notice.contains(doc.activeElement);
        notice.hidden = true;
        if (hadFocus)
          doc.getElementById("conteudo")?.focus({ preventScroll: true });
        if (consent === "granted") load();
      },
      { signal },
    );
  }
  return () => listeners.abort();
}
