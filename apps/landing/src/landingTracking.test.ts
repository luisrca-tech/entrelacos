// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { contactMessageFor, defaultContactUrl } from "./landingConfig";
import {
  type ClickDestinations,
  classifyClick,
  consentStorageKey,
  contactRef,
  mountLandingTracking,
  type TrackingSettings,
  trackingIds,
  withContactRef,
} from "./landingTracking";

const contactUrl = defaultContactUrl;
const destinations: ClickDestinations = {
  botanicalUrl: "https://demo-botanico.example/",
  lettersUrl: "https://demo-cartas.example/",
  contactUrl,
};
const ids = { metaPixelId: "123456789012345", ga4Id: "G-TEST123" };

type TrackingWindow = Window & {
  fbq?: { queue: unknown[][] } & ((...args: unknown[]) => void);
  dataLayer?: IArguments[];
};

function settings(overrides: Partial<TrackingSettings> = {}): TrackingSettings {
  return { ...destinations, ...ids, ...overrides };
}

function render(position = "cabecalho") {
  document.body.innerHTML = `
    <header data-track-position="${position}"><a id="contact" href="${contactUrl}">Falar no WhatsApp</a></header>
    <a id="botanical" href="${destinations.botanicalUrl}" target="_blank">Cinema Botânico</a>
    <a id="mural" href="${destinations.lettersUrl}#mural">Mural</a>
    <a id="faq" href="/duvidas">Dúvidas</a>
    <aside class="consent-notice" hidden>
      <button type="button" data-consent="granted">Aceitar</button>
      <button type="button" data-consent="denied">Recusar</button>
    </aside>`;
}

function scripts() {
  return [...document.querySelectorAll<HTMLScriptElement>("script[src]")].map(
    (script) => script.src,
  );
}

function notice() {
  return document.querySelector<HTMLElement>(".consent-notice");
}

let cleanup = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  localStorage.clear();
  sessionStorage.clear();
  const browser = window as TrackingWindow;
  delete browser.fbq;
  delete browser.dataLayer;
  delete (window as { _fbq?: unknown })._fbq;
  delete (window as { gtag?: unknown }).gtag;
  vi.restoreAllMocks();
});

describe("tracking identifiers", () => {
  it("treats missing or blank identifiers as disabled", () => {
    expect(trackingIds({})).toEqual({});
    expect(
      trackingIds({ PUBLIC_META_PIXEL_ID: " ", PUBLIC_GA4_MEASUREMENT_ID: "" }),
    ).toEqual({});
  });
  it("keeps valid identifiers", () => {
    expect(
      trackingIds({
        PUBLIC_META_PIXEL_ID: " 123456789012345 ",
        PUBLIC_GA4_MEASUREMENT_ID: "G-ABC123",
      }),
    ).toEqual({ metaPixelId: "123456789012345", ga4Id: "G-ABC123" });
  });
  it.each([
    ["PUBLIC_META_PIXEL_ID", "abc"],
    ["PUBLIC_GA4_MEASUREMENT_ID", "UA-1234-1"],
  ])("rejects a malformed %s", (key, value) => {
    expect(() => trackingIds({ [key]: value })).toThrow(key);
  });
});

describe("click classification", () => {
  it.each([
    ["https://demo-botanico.example/", "Cinema Botânico"],
    ["https://demo-botanico.example/?x=1", "Cinema Botânico"],
    ["https://demo-cartas.example/", "Cartas do Nosso Sim"],
    ["https://demo-cartas.example/#mural", "Cartas do Nosso Sim"],
  ])("classifies %s as a demo view", (href, name) => {
    expect(classifyClick(href, "rodape", destinations)).toEqual({
      kind: "demo",
      contentName: name,
    });
  });
  it("classifies the contact link with its position, even with a ref", () => {
    expect(
      classifyClick(
        withContactRef(contactUrl, "ig-casamentos"),
        "inicio",
        destinations,
      ),
    ).toEqual({ kind: "contact", contentName: "inicio" });
  });
  it.each([
    "/duvidas",
    "#modelos",
    "https://demo-botanico.example/outra",
    "https://wa.me/5500000000000",
    "not a url",
  ])("ignores %s", (href) => {
    expect(classifyClick(href, "inicio", destinations)).toBeNull();
  });
});

describe("advertising reference for WhatsApp", () => {
  it("is absent without campaign parameters", () => {
    expect(contactRef("")).toBeNull();
    expect(contactRef("?utm_medium=paid&foo=bar")).toBeNull();
  });
  it.each([
    ["?utm_source=instagram&utm_campaign=Noivas 2027", "ig-noivas-2027"],
    ["?utm_source=ig&utm_campaign=verao", "ig-verao"],
    ["?utm_source=facebook&utm_campaign=verao", "fb-verao"],
    ["?utm_source=Google+Ads", "google-ads"],
    ["?utm_campaign=verao", "ads-verao"],
    ["?fbclid=abc123", "meta"],
    ["?fbclid=abc123&utm_campaign=verao", "meta-verao"],
    [
      `?utm_source=instagram&utm_campaign=${"a".repeat(80)}`,
      `ig-${"a".repeat(40)}`,
    ],
  ])("builds a short reference from %s", (search, ref) => {
    expect(contactRef(search)).toBe(ref);
  });
  it("leaves the message untouched without a reference", () => {
    expect(withContactRef(contactUrl, null)).toBe(contactUrl);
  });
  it.each([
    ["ig-verao", "pelo Instagram"],
    ["ig", "pelo Instagram"],
    ["fb-verao", "pelo Facebook"],
    ["meta-verao", "por um anúncio"],
    ["google-ads", "por um anúncio"],
    ["ads-verao", "por um anúncio"],
  ])(
    "names where the visitor came from for %s, without codes",
    (ref, channel) => {
      const url = new URL(withContactRef(contactUrl, ref));
      const text = url.searchParams.get("text");
      expect(text).toBe(
        `Olá! Conheci o Entrelaços ${channel} e quero saber mais sobre o site para o nosso casamento.`,
      );
      expect(text).not.toContain("ref");
      expect(`${url.origin}${url.pathname}`).toBe(
        "https://wa.me/5562991339861",
      );
      expect(url.search).not.toContain("+");
    },
  );
  it("only changes wa.me destinations", () => {
    const form = "https://forms.example/contato?text=oi";
    expect(withContactRef(form, "ig-verao")).toBe(form);
  });
});

describe("mounting", () => {
  it("loads nothing and shows no notice without identifiers", () => {
    render();
    cleanup = mountLandingTracking(
      document,
      window,
      settings({ metaPixelId: undefined, ga4Id: undefined }),
    );
    expect(scripts()).toEqual([]);
    expect(notice()?.hidden).toBe(true);
    expect((window as TrackingWindow).fbq).toBeUndefined();
    expect((window as TrackingWindow).dataLayer).toBeUndefined();
  });

  it("waits for consent before loading any tracker", () => {
    render();
    cleanup = mountLandingTracking(document, window, settings());
    expect(notice()?.hidden).toBe(false);
    expect(scripts()).toEqual([]);
    document.querySelector<HTMLAnchorElement>("#botanical")?.click();
    expect((window as TrackingWindow).fbq).toBeUndefined();
  });

  it("stores a refusal and loads nothing", () => {
    render();
    cleanup = mountLandingTracking(document, window, settings());
    document
      .querySelector<HTMLButtonElement>('[data-consent="denied"]')
      ?.click();
    expect(localStorage.getItem(consentStorageKey)).toBe("denied");
    expect(notice()?.hidden).toBe(true);
    expect(scripts()).toEqual([]);
    cleanup();
    render();
    cleanup = mountLandingTracking(document, window, settings());
    expect(notice()?.hidden).toBe(true);
    expect(scripts()).toEqual([]);
  });

  it("loads Meta Pixel and GA4 once the visitor accepts", () => {
    render();
    cleanup = mountLandingTracking(document, window, settings());
    document
      .querySelector<HTMLButtonElement>('[data-consent="granted"]')
      ?.click();
    expect(localStorage.getItem(consentStorageKey)).toBe("granted");
    expect(notice()?.hidden).toBe(true);
    expect(scripts()).toEqual([
      "https://connect.facebook.net/en_US/fbevents.js",
      "https://www.googletagmanager.com/gtag/js?id=G-TEST123",
    ]);
    const browser = window as TrackingWindow;
    expect(browser.fbq?.queue.map((call) => [...call])).toEqual([
      ["init", ids.metaPixelId],
      ["track", "PageView"],
    ]);
    expect(browser.dataLayer?.map((call) => [...call].slice(0, 2))).toEqual([
      ["js", expect.any(Date)],
      ["config", "G-TEST123"],
    ]);
  });

  it("loads only the configured tracker after a previous acceptance", () => {
    localStorage.setItem(consentStorageKey, "granted");
    render();
    cleanup = mountLandingTracking(
      document,
      window,
      settings({ ga4Id: undefined }),
    );
    expect(notice()?.hidden).toBe(true);
    expect(scripts()).toEqual([
      "https://connect.facebook.net/en_US/fbevents.js",
    ]);
    expect((window as TrackingWindow).dataLayer).toBeUndefined();
  });

  it("sends demo and contact events without blocking navigation", () => {
    localStorage.setItem(consentStorageKey, "granted");
    render();
    cleanup = mountLandingTracking(document, window, settings());
    const browser = window as TrackingWindow;
    const prevented: boolean[] = [];
    document.addEventListener("click", (event) => {
      prevented.push(event.defaultPrevented);
      event.preventDefault(); // jsdom cannot navigate
    });
    document.querySelector<HTMLAnchorElement>("#botanical")?.click();
    document.querySelector<HTMLAnchorElement>("#mural")?.click();
    document.querySelector<HTMLAnchorElement>("#contact")?.click();
    document.querySelector<HTMLAnchorElement>("#faq")?.click();
    expect(prevented).toEqual([false, false, false, false]);
    expect(browser.fbq?.queue.slice(2).map((call) => [...call])).toEqual([
      ["track", "ViewContent", { content_name: "Cinema Botânico" }],
      ["track", "ViewContent", { content_name: "Cartas do Nosso Sim" }],
      ["track", "Contact", { content_name: "cabecalho" }],
    ]);
    expect(browser.dataLayer?.slice(2).map((call) => [...call])).toEqual([
      ["event", "view_demo", { content_name: "Cinema Botânico" }],
      ["event", "view_demo", { content_name: "Cartas do Nosso Sim" }],
      ["event", "contact_whatsapp", { content_name: "cabecalho" }],
    ]);
  });

  it("tracks the sticky mobile button as a contact from its fixed position", () => {
    localStorage.setItem(consentStorageKey, "granted");
    render("fixo");
    cleanup = mountLandingTracking(document, window, settings());
    document.addEventListener("click", (event) => event.preventDefault());
    document.querySelector<HTMLAnchorElement>("#contact")?.click();
    const browser = window as TrackingWindow;
    expect(browser.fbq?.queue.slice(2).map((call) => [...call])).toEqual([
      ["track", "Contact", { content_name: "fixo" }],
    ]);
    expect(browser.dataLayer?.slice(2).map((call) => [...call])).toEqual([
      ["event", "contact_whatsapp", { content_name: "fixo" }],
    ]);
  });

  it("adds the campaign reference to contact links, even without trackers", () => {
    window.history.replaceState(
      null,
      "",
      "/?utm_source=instagram&utm_campaign=verao",
    );
    render();
    cleanup = mountLandingTracking(
      document,
      window,
      settings({ metaPixelId: undefined, ga4Id: undefined }),
    );
    const link = document.querySelector<HTMLAnchorElement>("#contact");
    expect(new URL(link?.href ?? "").searchParams.get("text")).toBe(
      contactMessageFor("ig-verao"),
    );
    expect(contactMessageFor("ig-verao")).toContain("pelo Instagram");
    expect(document.querySelector<HTMLAnchorElement>("#botanical")?.href).toBe(
      destinations.botanicalUrl,
    );
    // The reference follows the visitor to other landing pages in the same tab.
    window.history.replaceState(null, "", "/duvidas");
    cleanup();
    render();
    cleanup = mountLandingTracking(
      document,
      window,
      settings({ metaPixelId: undefined, ga4Id: undefined }),
    );
    expect(document.querySelector<HTMLAnchorElement>("#contact")?.href).toBe(
      withContactRef(contactUrl, "ig-verao"),
    );
    window.history.replaceState(null, "", "/");
  });

  it("keeps the original message without campaign parameters", () => {
    window.history.replaceState(null, "", "/");
    render();
    cleanup = mountLandingTracking(document, window, settings());
    expect(document.querySelector<HTMLAnchorElement>("#contact")?.href).toBe(
      contactUrl,
    );
  });

  it("still works when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render();
    cleanup = mountLandingTracking(document, window, settings());
    expect(notice()?.hidden).toBe(false);
    document
      .querySelector<HTMLButtonElement>('[data-consent="granted"]')
      ?.click();
    expect(scripts()).toHaveLength(2);
  });
});
