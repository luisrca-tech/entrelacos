import type { Media } from "../content";

const BRAND_HOLD_MS = 500;
const SPLIT_GROW_MS = 950;
const REVEAL_STAGGER_MS = 250;
const FRAME_REVEAL_MS = 900;
const FULLSCREEN_GROW_MS = 1000;
export const OVERLAY_FADE_MS = 500;

export type HomeIntroTimeline = {
  splitAt: number;
  firstRevealAt: number;
  revealAt: number[];
  fullscreenAt: number;
  fadeAt: number;
  completeAt: number;
};

export function buildIntroTimeline(frameCount: number): HomeIntroTimeline {
  const safeFrameCount = Number.isFinite(frameCount)
    ? Math.max(1, Math.floor(frameCount))
    : 1;
  const splitAt = BRAND_HOLD_MS;
  const firstRevealAt = splitAt;
  const revealStagger = Math.min(
    REVEAL_STAGGER_MS,
    1000 / Math.max(1, safeFrameCount - 2),
  );
  const revealAt = Array.from({ length: safeFrameCount }, (_, index) =>
    index === 0
      ? firstRevealAt
      : splitAt + SPLIT_GROW_MS + (index - 1) * revealStagger,
  );
  const fullscreenAt = revealAt[safeFrameCount - 1] + FRAME_REVEAL_MS;
  const fadeAt = fullscreenAt + FULLSCREEN_GROW_MS;

  return {
    splitAt,
    firstRevealAt,
    revealAt,
    fullscreenAt,
    fadeAt,
    completeAt: fadeAt + OVERLAY_FADE_MS,
  };
}

export function introFrames(media: readonly Media[], hero: Media): Media[] {
  return [...media.slice(0, Math.max(1, media.length - 1)), hero];
}

export function introSourceForMedia(media: Media): string {
  return media.kind === "video" ? media.poster : media.src;
}

export function shouldExpandIntroIntoHero(
  heroRect: Pick<DOMRect, "top" | "bottom"> | null,
  viewportHeight: number,
): boolean {
  if (!heroRect) return false;
  return heroRect.bottom > 0 && heroRect.top < viewportHeight;
}
