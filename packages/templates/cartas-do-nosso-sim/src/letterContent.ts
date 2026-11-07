import {
  type HeroAction,
  type ImageMedia,
  type SectionContent,
  validateMedia,
  validateNavigation,
  validateSectionContent,
  validateSectionIds,
  validateSerializableContent,
} from "./content";

export type LetterContent = {
  cover: SectionContent;
  dateLabel: string;
  locationLabel: string;
  monogram: string;
  action: HeroAction;
  story: SectionContent & { paragraphs: readonly string[] };
  photos: readonly ImageMedia[];
  signature: string;
  coverHandoff?: string;
  storyHandoff?: string;
};

export function validateLetterContent(content: LetterContent): void {
  validateSerializableContent(content);
  validateSectionContent(content.cover, "letter.cover");
  validateSectionContent(content.story, "letter.story");
  validateSectionIds([
    content.cover.id,
    `${content.cover.id}-title`,
    content.story.id,
    `${content.story.id}-title`,
  ]);
  for (const key of [
    "dateLabel",
    "locationLabel",
    "monogram",
    "signature",
  ] as const) {
    if (typeof content[key] !== "string" || !content[key].trim())
      throw new TypeError(`letter.${key} must be a non-empty string`);
  }
  for (const key of ["coverHandoff", "storyHandoff"] as const) {
    const value = content[key];
    if (value !== undefined && (typeof value !== "string" || !value.trim()))
      throw new TypeError(`letter.${key} must be a non-empty string`);
  }
  validateNavigation({
    ariaLabel: "Letter reply",
    menuLabel: "Menu",
    links: [content.action],
  });
  if (
    !Array.isArray(content.photos) ||
    content.photos.length < 2 ||
    content.photos.length > 3
  )
    throw new TypeError("letter requires two or three photos");
  content.photos.forEach((photo) => {
    if (photo.kind !== "image")
      throw new TypeError("letter photos must be images");
    validateMedia(photo);
  });
  if (
    !Array.isArray(content.story.paragraphs) ||
    content.story.paragraphs.length === 0 ||
    content.story.paragraphs.some(
      (paragraph) => typeof paragraph !== "string" || !paragraph.trim(),
    )
  )
    throw new TypeError("letter story requires non-empty paragraphs");
}
