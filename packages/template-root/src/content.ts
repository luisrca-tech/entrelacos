export type RobotsDirective = "index, follow" | "noindex, nofollow";

export type SocialImage = {
  url: string;
  alt: string;
};

export type PageSeo = {
  title: string;
  description: string;
  canonical: string;
  robots: RobotsDirective;
  socialImage: SocialImage;
};

export type SiteIdentity = {
  name: string;
  href: string;
};

export type NavigationLink = {
  label: string;
  href: string;
};

export type Navigation = {
  ariaLabel: string;
  menuLabel: string;
  links: readonly NavigationLink[];
  /** IDs rendered by host-owned stable extension slots used by local links. */
  extensionAnchorIds?: readonly string[];
};

export type FooterContent = {
  names: string;
  dateLabel: string;
  links: readonly NavigationLink[];
  rsvp: NavigationLink;
  year: string;
  copyright: string;
  attribution: string;
};

export type ImageMedia = {
  kind: "image";
  src: string;
  alt: string;
  width: number;
  height: number;
};

export type VideoMedia = {
  kind: "video";
  src: string;
  poster: string;
  alt: string;
  width: number;
  height: number;
};

export type Media = ImageMedia | VideoMedia;

export type HeroAction = NavigationLink;

export type SectionContent = {
  id: string;
  eyebrow?: string;
  title: string;
  description?: string;
  body?: string;
};

export type StoryEntry = {
  id: string;
  eyebrow?: string;
  title: string;
  body: string;
  media?: Media;
};

export type StoryContent = SectionContent & {
  entries: readonly StoryEntry[];
};

export type HeroContent = SectionContent & {
  dateLabel: string;
  locationLabel: string;
  media: Media;
  action?: HeroAction;
};

export type GalleryControls = {
  ariaLabel: string;
  previousLabel: string;
  nextLabel: string;
  openLabel: string;
};

export type GalleryItem = {
  id: string;
  media: Media;
  caption?: string;
};

export type GalleryContent = SectionContent & {
  controls: GalleryControls;
  items: readonly GalleryItem[];
};

export type ScheduleEntry = {
  id: string;
  time: string;
  title: string;
  body: string;
  location?: string;
};

export type PracticalGuidance = {
  id: string;
  title: string;
  body: string;
};

export type ScheduleContent = SectionContent & {
  guidanceLabel: string;
  entries: readonly ScheduleEntry[];
  guidance?: readonly PracticalGuidance[];
};

export type VenueLabels = {
  mapTitle: string;
  addressLabel: string;
  copyLabel: string;
  copiedLabel: string;
  copyErrorLabel: string;
};

export type VenueContent = SectionContent & {
  name: string;
  address: string;
  mapEmbedUrl: string;
  directions: NavigationLink;
  fallback: NavigationLink;
  labels: VenueLabels;
};

export type HomeSectionKey =
  | "hero"
  | "story"
  | "details"
  | "gallery"
  | "schedule"
  | "venue";

export type WeddingLayoutProps = {
  locale: string;
  site: SiteIdentity;
  seo: PageSeo;
  navigation?: Navigation;
  footer?: FooterContent;
  /** Internal layout hint set by the home preset when a hero is rendered. */
  hasHero?: boolean;
};

export type WeddingHomeProps = WeddingLayoutProps & {
  navigation: Navigation;
  hero: HeroContent;
  story?: StoryContent;
  details?: SectionContent;
  gallery?: GalleryContent;
  schedule?: ScheduleContent;
  venue?: VenueContent;
  sectionOrder?: readonly HomeSectionKey[];
};

function assertObject(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertNonEmptyString(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertSafeHref(value: unknown, name: string): asserts value is string {
  assertNonEmptyString(value, name);
  const href = value.trim();
  if (href.includes("\\")) {
    throw new TypeError(`${name} must use a safe relative or HTTP(S) URL`);
  }
  if (
    [...href].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw new TypeError(`${name} must use a safe relative or HTTP(S) URL`);
  }
  if (/^https?:\/\//i.test(href)) {
    let parsed: URL;
    try {
      parsed = new URL(href);
    } catch {
      throw new TypeError(`${name} must use a safe relative or HTTP(S) URL`);
    }
    if (parsed.username || parsed.password) {
      throw new TypeError(`${name} must use a safe relative or HTTP(S) URL`);
    }
  }
  if (
    /^\/\//.test(href) ||
    (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^https?:\/\//i.test(href))
  ) {
    throw new TypeError(`${name} must use a safe relative or HTTP(S) URL`);
  }
}

function assertAbsoluteHttpUrl(
  value: unknown,
  name: string,
): asserts value is string {
  assertNonEmptyString(value, name);
  const url = value.trim();
  if (
    url.includes("\\") ||
    [...url].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    }) ||
    !/^https?:\/\//i.test(url)
  ) {
    throw new TypeError(`${name} must be an absolute HTTP(S) URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`${name} must be an absolute HTTP(S) URL`);
  }
  if (
    !/^https?:$/.test(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    throw new TypeError(`${name} must be an absolute HTTP(S) URL`);
  }
}

function assertGoogleMapsHost(url: URL, name: string): void {
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !["google.com", "www.google.com", "maps.google.com"].includes(
      url.hostname.toLowerCase(),
    )
  ) {
    throw new TypeError(`${name} must use an approved Google Maps URL`);
  }
}

export function validateMapEmbedUrl(value: unknown): asserts value is string {
  assertAbsoluteHttpUrl(value, "venue.mapEmbedUrl");
  const url = new URL(value);
  assertGoogleMapsHost(url, "venue.mapEmbedUrl");
  const path = url.pathname.replace(/\/$/, "");
  const isEmbedPath = path === "/maps/embed" || path === "/maps/d/embed";
  const isLegacyEmbed =
    url.hostname.toLowerCase() === "maps.google.com" &&
    path === "/maps" &&
    url.searchParams.get("output") === "embed";
  if (!isEmbedPath && !isLegacyEmbed)
    throw new TypeError(
      "venue.mapEmbedUrl must use an approved Google Maps embed form",
    );
}

export function validateGoogleMapsDirectionsUrl(
  value: unknown,
): asserts value is string {
  assertAbsoluteHttpUrl(value, "venue.directions.href");
  const url = new URL(value);
  assertGoogleMapsHost(url, "venue.directions.href");
  const path = url.pathname.replace(/\/$/, "");
  if (path !== "/maps/dir" && path !== "/maps")
    throw new TypeError(
      "venue.directions.href must use an approved Google Maps directions URL",
    );
}

export function validateSerializableContent(
  value: unknown,
  path = "content",
  seen = new Set<unknown>(),
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError(`${path} must contain finite numbers`);
  }
  if (Array.isArray(value)) {
    if (seen.has(value))
      throw new TypeError(`${path} must contain plain serializable values`);
    seen.add(value);
    for (let index = 0; index < value.length; index += 1)
      validateSerializableContent(value[index], `${path}.${index}`, seen);
    seen.delete(value);
    return;
  }
  if (
    typeof value !== "object" ||
    seen.has(value) ||
    value instanceof Date ||
    value instanceof Map ||
    value instanceof Set ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError(`${path} must contain plain serializable values`);
  }
  seen.add(value);
  for (const [key, child] of Object.entries(value))
    validateSerializableContent(child, `${path}.${key}`, seen);
  seen.delete(value);
}

export function validateSiteIdentity(
  value: unknown,
): asserts value is SiteIdentity {
  assertObject(value, "site");
  validateSerializableContent(value, "site");
  assertNonEmptyString(value.name, "site.name");
  assertSafeHref(value.href, "site.href");
}

export function validatePageSeo(value: unknown): PageSeo {
  assertObject(value, "seo");
  validateSerializableContent(value, "seo");
  assertNonEmptyString(value.title, "seo.title");
  assertNonEmptyString(value.description, "seo.description");
  assertAbsoluteHttpUrl(value.canonical, "seo.canonical");
  if (new URL(value.canonical).hash)
    throw new TypeError("seo.canonical must not contain a fragment");
  if (
    value.robots !== "index, follow" &&
    value.robots !== "noindex, nofollow"
  ) {
    throw new TypeError("seo.robots must be a supported robots directive");
  }
  assertObject(value.socialImage, "seo.socialImage");
  assertAbsoluteHttpUrl(value.socialImage.url, "seo.socialImage.url");
  assertNonEmptyString(value.socialImage.alt, "seo.socialImage.alt");
  return value as PageSeo;
}

export function validateNavigation(
  value: unknown,
  renderedAnchorIds?: readonly string[],
): asserts value is Navigation {
  assertObject(value, "navigation");
  validateSerializableContent(value, "navigation");
  assertNonEmptyString(value.ariaLabel, "navigation.ariaLabel");
  assertNonEmptyString(value.menuLabel, "navigation.menuLabel");
  if (!Array.isArray(value.links))
    throw new TypeError("navigation.links must be an array");
  const extensionAnchorIds = value.extensionAnchorIds;
  if (extensionAnchorIds !== undefined) {
    if (!Array.isArray(extensionAnchorIds))
      throw new TypeError("navigation.extensionAnchorIds must be an array");
    validateSectionIds(extensionAnchorIds);
  }
  const availableAnchorIds =
    renderedAnchorIds === undefined ? undefined : new Set<string>();
  if (availableAnchorIds && renderedAnchorIds !== undefined) {
    for (let index = 0; index < renderedAnchorIds.length; index += 1)
      availableAnchorIds.add(renderedAnchorIds[index]);
    const extensionIds: readonly string[] = Array.isArray(extensionAnchorIds)
      ? extensionAnchorIds
      : [];
    for (let index = 0; index < extensionIds.length; index += 1)
      availableAnchorIds.add(extensionIds[index]);
  }
  const hrefs = new Set<string>();
  for (let index = 0; index < value.links.length; index += 1) {
    const link = value.links[index];
    validateNavigationLink(link, `navigation.links[${index}]`);
    if (link.href.startsWith("#")) {
      const anchor = link.href.slice(1);
      if (!anchor) throw new TypeError("navigation link anchor is invalid");
      validateSectionIds([anchor]);
      if (availableAnchorIds && !availableAnchorIds.has(anchor)) {
        throw new TypeError(
          `navigation link references unavailable anchor: ${link.href}`,
        );
      }
    }
    if (hrefs.has(link.href))
      throw new TypeError(`navigation.links[${index}].href must be unique`);
    hrefs.add(link.href);
  }
}

function validateNavigationLink(
  value: unknown,
  name: string,
): asserts value is NavigationLink {
  assertObject(value, name);
  validateSerializableContent(value, name);
  assertNonEmptyString(value.label, `${name}.label`);
  assertSafeHref(value.href, `${name}.href`);
}

export function validateMedia(
  value: unknown,
  name = "media",
): asserts value is Media {
  assertObject(value, name);
  validateSerializableContent(value, name);
  if (value.kind !== "image" && value.kind !== "video")
    throw new TypeError(`${name}.kind is invalid`);
  assertSafeHref(value.src, `${name}.src`);
  assertNonEmptyString(value.alt, `${name}.alt`);
  if (value.kind === "video") assertSafeHref(value.poster, `${name}.poster`);
  for (const dimension of ["width", "height"] as const) {
    if (
      typeof value[dimension] !== "number" ||
      !Number.isFinite(value[dimension]) ||
      value[dimension] <= 0
    ) {
      throw new TypeError(
        `${name}.${dimension} must be a finite positive number`,
      );
    }
  }
}

export function validateSectionContent(
  value: unknown,
  name = "section",
): asserts value is SectionContent {
  assertObject(value, name);
  validateSerializableContent(value, name);
  assertNonEmptyString(value.id, `${name}.id`);
  validateSectionIds([value.id]);
  assertNonEmptyString(value.title, `${name}.title`);
  if (value.eyebrow !== undefined)
    assertNonEmptyString(value.eyebrow, `${name}.eyebrow`);
  if (value.description !== undefined)
    assertNonEmptyString(value.description, `${name}.description`);
  if (value.body !== undefined)
    assertNonEmptyString(value.body, `${name}.body`);
}

function validateStoryEntry(
  value: unknown,
  name: string,
): asserts value is StoryEntry {
  assertObject(value, name);
  validateSerializableContent(value, name);
  assertNonEmptyString(value.id, `${name}.id`);
  validateSectionIds([value.id]);
  assertNonEmptyString(value.title, `${name}.title`);
  assertNonEmptyString(value.body, `${name}.body`);
  if (value.eyebrow !== undefined)
    assertNonEmptyString(value.eyebrow, `${name}.eyebrow`);
  if (value.media !== undefined) validateMedia(value.media, `${name}.media`);
}

export function validateStoryContent(
  value: unknown,
): asserts value is StoryContent {
  validateSectionContent(value, "story");
  assertObject(value, "story");
  if (!Array.isArray(value.entries) || value.entries.length < 2)
    throw new TypeError("story.entries must contain at least two entries");

  const ids = [value.id];
  for (let index = 0; index < value.entries.length; index += 1) {
    const entry = value.entries[index];
    validateStoryEntry(entry, `story.entries[${index}]`);
    ids.push(entry.id);
  }
  validateSectionIds(ids);
}

export function validateHeroContent(
  value: unknown,
): asserts value is HeroContent {
  validateSectionContent(value, "hero");
  assertNonEmptyString(value.dateLabel, "hero.dateLabel");
  assertNonEmptyString(value.locationLabel, "hero.locationLabel");
  validateMedia(value.media, "hero.media");
  if (value.action !== undefined)
    validateNavigationLink(value.action, "hero.action");
}

function validateGalleryControls(
  value: unknown,
): asserts value is GalleryControls {
  assertObject(value, "gallery.controls");
  validateSerializableContent(value, "gallery.controls");
  assertNonEmptyString(value.ariaLabel, "gallery.controls.ariaLabel");
  assertNonEmptyString(value.previousLabel, "gallery.controls.previousLabel");
  assertNonEmptyString(value.nextLabel, "gallery.controls.nextLabel");
  assertNonEmptyString(value.openLabel, "gallery.controls.openLabel");
}

function validateGalleryItem(
  value: unknown,
  name: string,
): asserts value is GalleryItem {
  assertObject(value, name);
  validateSerializableContent(value, name);
  assertNonEmptyString(value.id, `${name}.id`);
  validateSectionIds([value.id]);
  validateMedia(value.media, `${name}.media`);
  if (value.caption !== undefined)
    assertNonEmptyString(value.caption, `${name}.caption`);
}

export function validateGalleryContent(
  value: unknown,
): asserts value is GalleryContent {
  validateSectionContent(value, "gallery");
  assertObject(value, "gallery");
  validateGalleryControls(value.controls);
  if (!Array.isArray(value.items) || value.items.length === 0)
    throw new TypeError("gallery.items must contain at least one item");
  const ids = [value.id];
  for (let index = 0; index < value.items.length; index += 1) {
    const item = value.items[index];
    validateGalleryItem(item, `gallery.items[${index}]`);
    ids.push(item.id);
  }
  validateSectionIds(ids);
}

function validateScheduleEntry(
  value: unknown,
  name: string,
): asserts value is ScheduleEntry {
  assertObject(value, name);
  validateSerializableContent(value, name);
  assertNonEmptyString(value.id, `${name}.id`);
  validateSectionIds([value.id]);
  assertNonEmptyString(value.time, `${name}.time`);
  assertNonEmptyString(value.title, `${name}.title`);
  assertNonEmptyString(value.body, `${name}.body`);
  if (value.location !== undefined)
    assertNonEmptyString(value.location, `${name}.location`);
}

function validatePracticalGuidance(
  value: unknown,
  name: string,
): asserts value is PracticalGuidance {
  assertObject(value, name);
  validateSerializableContent(value, name);
  assertNonEmptyString(value.id, `${name}.id`);
  validateSectionIds([value.id]);
  assertNonEmptyString(value.title, `${name}.title`);
  assertNonEmptyString(value.body, `${name}.body`);
}

export function validateScheduleContent(
  value: unknown,
): asserts value is ScheduleContent {
  validateSectionContent(value, "schedule");
  assertObject(value, "schedule");
  assertNonEmptyString(value.guidanceLabel, "schedule.guidanceLabel");
  if (!Array.isArray(value.entries) || value.entries.length < 2)
    throw new TypeError("schedule.entries must contain at least two entries");
  const ids = [value.id];
  for (let index = 0; index < value.entries.length; index += 1) {
    const entry = value.entries[index];
    validateScheduleEntry(entry, `schedule.entries[${index}]`);
    ids.push(entry.id);
  }
  if (value.guidance !== undefined) {
    if (!Array.isArray(value.guidance))
      throw new TypeError("schedule.guidance must be an array");
    for (let index = 0; index < value.guidance.length; index += 1) {
      const guidance = value.guidance[index];
      validatePracticalGuidance(guidance, `schedule.guidance[${index}]`);
      ids.push(guidance.id);
    }
  }
  validateSectionIds(ids);
}

function validateVenueLabels(value: unknown): asserts value is VenueLabels {
  assertObject(value, "venue.labels");
  validateSerializableContent(value, "venue.labels");
  assertNonEmptyString(value.mapTitle, "venue.labels.mapTitle");
  assertNonEmptyString(value.addressLabel, "venue.labels.addressLabel");
  assertNonEmptyString(value.copyLabel, "venue.labels.copyLabel");
  assertNonEmptyString(value.copiedLabel, "venue.labels.copiedLabel");
  assertNonEmptyString(value.copyErrorLabel, "venue.labels.copyErrorLabel");
}

export function validateVenueContent(
  value: unknown,
): asserts value is VenueContent {
  validateSectionContent(value, "venue");
  assertObject(value, "venue");
  assertNonEmptyString(value.name, "venue.name");
  assertNonEmptyString(value.address, "venue.address");
  validateMapEmbedUrl(value.mapEmbedUrl);
  validateNavigationLink(value.directions, "venue.directions");
  validateGoogleMapsDirectionsUrl(value.directions.href);
  validateNavigationLink(value.fallback, "venue.fallback");
  validateVenueLabels(value.labels);
}

export function validateSectionIds(ids: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    if (typeof id !== "string" || !/^[A-Za-z][A-Za-z0-9:_-]*$/.test(id))
      throw new TypeError(`section ID is invalid: ${id}`);
    if (seen.has(id)) throw new TypeError(`section ID must be unique: ${id}`);
    seen.add(id);
  }
  return ids;
}

export function validateFooterContent(
  value: unknown,
): asserts value is FooterContent {
  assertObject(value, "footer");
  validateSerializableContent(value, "footer");
  assertNonEmptyString(value.names, "footer.names");
  assertNonEmptyString(value.dateLabel, "footer.dateLabel");
  if (!Array.isArray(value.links))
    throw new TypeError("footer.links must be an array");
  const hrefs = new Set<string>();
  for (let index = 0; index < value.links.length; index += 1) {
    validateNavigationLink(value.links[index], `footer.links[${index}]`);
    if (hrefs.has(value.links[index].href))
      throw new TypeError(`footer.links[${index}].href must be unique`);
    hrefs.add(value.links[index].href);
  }
  validateNavigationLink(value.rsvp, "footer.rsvp");
  assertNonEmptyString(value.year, "footer.year");
  assertNonEmptyString(value.copyright, "footer.copyright");
  assertNonEmptyString(value.attribution, "footer.attribution");
}

export function validateWeddingLayoutProps(value: WeddingLayoutProps): void {
  assertObject(value, "layout");
  assertNonEmptyString(value.locale, "locale");
  validateSiteIdentity(value.site);
  validatePageSeo(value.seo);
  if (value.hasHero !== undefined && typeof value.hasHero !== "boolean")
    throw new TypeError("hasHero must be a boolean");
  if (value.navigation !== undefined) validateNavigation(value.navigation);
  if (value.footer !== undefined) validateFooterContent(value.footer);
}

export function validateWeddingHomeProps(
  value: WeddingHomeProps,
): readonly HomeSectionKey[] {
  validateWeddingLayoutProps(value);
  if (value.navigation === undefined)
    throw new TypeError("navigation is required for the home preset");
  validateHeroContent(value.hero);
  if (value.story !== undefined) validateStoryContent(value.story);
  if (value.details !== undefined)
    validateSectionContent(value.details, "details");
  if (value.gallery !== undefined) validateGalleryContent(value.gallery);
  if (value.schedule !== undefined) validateScheduleContent(value.schedule);
  if (value.venue !== undefined) validateVenueContent(value.venue);
  let order: HomeSectionKey[];
  if (value.sectionOrder === undefined) {
    order = [
      "hero",
      ...(value.story !== undefined ? ["story" as const] : []),
      ...(value.details !== undefined ? ["details" as const] : []),
      ...(value.gallery !== undefined ? ["gallery" as const] : []),
      ...(value.schedule !== undefined ? ["schedule" as const] : []),
      ...(value.venue !== undefined ? ["venue" as const] : []),
    ];
  } else {
    if (!Array.isArray(value.sectionOrder))
      throw new TypeError("sectionOrder must be a non-empty array");
    order = [];
    for (let index = 0; index < value.sectionOrder.length; index += 1)
      order.push(value.sectionOrder[index]);
  }
  if (!Array.isArray(order) || order.length === 0)
    throw new TypeError("sectionOrder must be a non-empty array");
  let heroCount = 0;
  for (let index = 0; index < order.length; index += 1) {
    if (order[index] === "hero") heroCount += 1;
  }
  if (heroCount !== 1)
    throw new TypeError("sectionOrder must contain hero exactly once");
  for (const key of order) {
    if (
      key !== "hero" &&
      key !== "story" &&
      key !== "details" &&
      key !== "gallery" &&
      key !== "schedule" &&
      key !== "venue"
    )
      throw new TypeError(`sectionOrder contains an unknown section: ${key}`);
  }
  const present = new Set<HomeSectionKey>(["hero"]);
  if (value.story !== undefined) present.add("story");
  if (value.details !== undefined) present.add("details");
  if (value.gallery !== undefined) present.add("gallery");
  if (value.schedule !== undefined) present.add("schedule");
  if (value.venue !== undefined) present.add("venue");
  validateSectionIds(order);
  for (const key of order) {
    if (!present.has(key))
      throw new TypeError(
        `sectionOrder references unavailable section: ${key}`,
      );
  }
  const sectionIds = order.map((key) => {
    if (key === "hero") return value.hero.id;
    if (key === "story") return value.story?.id ?? "";
    if (key === "details") return value.details?.id ?? "";
    if (key === "gallery") return value.gallery?.id ?? "";
    if (key === "schedule") return value.schedule?.id ?? "";
    return value.venue?.id ?? "";
  });
  validateSectionIds(sectionIds);
  const renderedIds = [...sectionIds];
  for (const key of order) {
    if (key === "story" && value.story !== undefined) {
      for (let index = 0; index < value.story.entries.length; index += 1)
        renderedIds.push(value.story.entries[index].id);
    }
    if (key === "gallery" && value.gallery !== undefined) {
      for (let index = 0; index < value.gallery.items.length; index += 1)
        renderedIds.push(value.gallery.items[index].id);
    }
    if (key === "schedule" && value.schedule !== undefined) {
      for (let index = 0; index < value.schedule.entries.length; index += 1)
        renderedIds.push(value.schedule.entries[index].id);
      for (
        let index = 0;
        index < (value.schedule.guidance?.length ?? 0);
        index += 1
      )
        renderedIds.push(value.schedule.guidance?.[index].id ?? "");
    }
  }
  validateSectionIds(renderedIds);
  const generatedIds: string[] = [];
  for (const key of order) {
    if (key === "hero") generatedIds.push(`${value.hero.id}-title`);
    if (key === "story" && value.story !== undefined) {
      generatedIds.push(`${value.story.id}-title`);
      for (const entry of value.story.entries)
        generatedIds.push(`${entry.id}-title`);
    }
    if (key === "gallery" && value.gallery !== undefined)
      generatedIds.push(`${value.gallery.id}-title`);
    if (key === "schedule" && value.schedule !== undefined) {
      generatedIds.push(`${value.schedule.id}-title`);
      if (value.schedule.guidance && value.schedule.guidance.length > 0)
        generatedIds.push(`${value.schedule.id}-guidance-title`);
    }
    if (key === "venue" && value.venue !== undefined) {
      generatedIds.push(`${value.venue.id}-title`, `${value.venue.id}-address`);
    }
  }
  validateSectionIds([
    ...renderedIds,
    ...generatedIds,
    ...(value.navigation.extensionAnchorIds ?? []),
  ]);
  validateNavigation(value.navigation, renderedIds);
  return order;
}
