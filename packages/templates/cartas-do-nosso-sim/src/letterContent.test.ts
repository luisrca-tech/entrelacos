import { describe, expect, it } from "vitest";
import { validateLetterContent } from "./letterContent";

const photo = {
  kind: "image" as const,
  src: "/one.webp",
  alt: "Together",
  width: 1200,
  height: 900,
};
const letter = {
  cover: { id: "hero", title: "Our wedding", eyebrow: "An invitation" },
  dateLabel: "September 18",
  locationLabel: "Our city",
  monogram: "M&C",
  action: { label: "Reply", href: "#guest-access" },
  story: {
    id: "story",
    title: "A letter",
    paragraphs: ["Our story begins here."],
  },
  photos: [photo, { ...photo, src: "/two.webp" }],
  signature: "With love",
  coverHandoff: "A letter for you",
  storyHandoff: "Join us",
};

describe("letter composition content", () => {
  it("accepts a letter without decorative transitions", () => {
    const { coverHandoff, storyHandoff, ...withoutTransitions } = letter;
    expect(() => validateLetterContent(withoutTransitions)).not.toThrow();
  });

  it.each(["coverHandoff", "storyHandoff"] as const)(
    "rejects an invalid optional %s",
    (key) => {
      for (const value of ["", "   ", null, 42]) {
        expect(() =>
          validateLetterContent({ ...letter, [key]: value }),
        ).toThrow(/must be a non-empty string/);
      }
    },
  );

  it("accepts two photos without dummy hero media or a gallery", () => {
    expect(() => validateLetterContent(letter)).not.toThrow();
  });
  it("accepts an optional third photo", () => {
    expect(() =>
      validateLetterContent({
        ...letter,
        photos: [...letter.photos, { ...photo, src: "/three.webp" }],
      }),
    ).not.toThrow();
  });
  it.each(
    [[], [photo], [...letter.photos, photo, photo]].map((photos) => ({
      photos,
    })),
  )("rejects an invalid photo budget: $photos.length", ({ photos }) => {
    expect(() => validateLetterContent({ ...letter, photos })).toThrow(
      /two or three/,
    );
  });
  it("rejects video and unsafe media URLs", () => {
    expect(() =>
      validateLetterContent({
        ...letter,
        photos: [{ ...photo, kind: "video" }, photo],
      }),
    ).toThrow(/image/);
    expect(() =>
      validateLetterContent({
        ...letter,
        photos: [{ ...photo, src: "javascript:alert(1)" }, photo],
      }),
    ).toThrow();
  });
  it("rejects missing prose and duplicate section IDs", () => {
    expect(() =>
      validateLetterContent({
        ...letter,
        story: { ...letter.story, paragraphs: [] },
      }),
    ).toThrow(/paragraph/);
    expect(() =>
      validateLetterContent({
        ...letter,
        story: { ...letter.story, id: "hero" },
      }),
    ).toThrow();
  });
  it.each([
    { coverId: "hero", storyId: "hero-title" },
    { coverId: "story-title", storyId: "story" },
  ])(
    "rejects section and heading ID collisions: $coverId / $storyId",
    ({ coverId, storyId }) => {
      expect(() =>
        validateLetterContent({
          ...letter,
          cover: { ...letter.cover, id: coverId },
          story: { ...letter.story, id: storyId },
        }),
      ).toThrow(/section ID must be unique/);
    },
  );
  it("rejects an unsafe reply destination", () => {
    expect(() =>
      validateLetterContent({
        ...letter,
        action: { ...letter.action, href: "javascript:alert(1)" },
      }),
    ).toThrow();
  });
});
