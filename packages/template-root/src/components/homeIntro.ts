import type { Media } from "../content";

const BRAND_HOLD_MS = 900;
const SPLIT_GROW_MS = 1400;
const REVEAL_STAGGER_MS = 350;
const FRAME_REVEAL_MS = 1200;
const FULLSCREEN_GROW_MS = 1200;
const OVERLAY_FADE_MS = 450;

export type HomeIntroTimeline = {
  splitAt: number;
  firstRevealAt: number;
  revealAt: number[];
  fullscreenAt: number;
  fadeAt: number;
  completeAt: number;
};

export function buildIntroTimeline(frameCount: number): HomeIntroTimeline {
  const safeFrameCount = Math.max(1, Math.floor(frameCount));
  const splitAt = BRAND_HOLD_MS;
  const firstRevealAt = splitAt;
  const revealAt = Array.from({ length: safeFrameCount }, (_, index) =>
    index === 0
      ? firstRevealAt
      : splitAt + SPLIT_GROW_MS + (index - 1) * REVEAL_STAGGER_MS,
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

export function introSourceForMedia(media: Media): string {
  return media.kind === "video" ? media.poster : media.src;
}
