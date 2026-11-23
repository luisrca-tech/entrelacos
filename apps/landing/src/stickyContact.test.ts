// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountStickyContact } from "./stickyContact";

let notify: IntersectionObserverCallback = () => {};
const disconnect = vi.fn();
let cleanup = () => {};

function render(noticeHidden = true) {
  document.body.innerHTML = `
    <div class="hero-actions"><a href="https://wa.me/1">Falar no WhatsApp</a></div>
    <div class="closing-actions"><a href="https://wa.me/1">Falar no WhatsApp</a></div>
    <div class="sticky-contact" data-track-position="fixo"><a href="https://wa.me/1">Falar no WhatsApp</a></div>
    <aside class="consent-notice"${noticeHidden ? " hidden" : ""}></aside>`;
}

function enter(selector: string, visible: boolean) {
  notify(
    [
      {
        target: document.querySelector(selector),
        isIntersecting: visible,
      } as IntersectionObserverEntry,
    ],
    {} as IntersectionObserver,
  );
}

const sticky = () =>
  document
    .querySelector<HTMLElement>(".sticky-contact")
    ?.hasAttribute("data-visible");

beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback;
      }
      observe = vi.fn();
      disconnect = disconnect;
    },
  );
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  document.body.innerHTML = "";
  disconnect.mockClear();
  vi.unstubAllGlobals();
});

describe("sticky mobile contact", () => {
  it("stays hidden while the hero CTA is in view and shows once it leaves", () => {
    render();
    cleanup = mountStickyContact(document);
    expect(sticky()).toBe(false);
    enter(".hero-actions", true);
    expect(sticky()).toBe(false);
    enter(".hero-actions", false);
    expect(sticky()).toBe(true);
  });

  it("hides again while the closing CTA is in view", () => {
    render();
    cleanup = mountStickyContact(document);
    enter(".hero-actions", false);
    enter(".closing-actions", true);
    expect(sticky()).toBe(false);
    enter(".closing-actions", false);
    expect(sticky()).toBe(true);
  });

  it("never shows over the cookie notice", async () => {
    render(false);
    cleanup = mountStickyContact(document);
    enter(".hero-actions", false);
    expect(sticky()).toBe(false);
    (document.querySelector(".consent-notice") as HTMLElement).hidden = true;
    await Promise.resolve();
    expect(sticky()).toBe(true);
    (document.querySelector(".consent-notice") as HTMLElement).hidden = false;
    await Promise.resolve();
    expect(sticky()).toBe(false);
  });

  it("stays hidden without IntersectionObserver and cleans up", () => {
    render();
    vi.stubGlobal("IntersectionObserver", undefined);
    cleanup = mountStickyContact(document);
    expect(sticky()).toBe(false);
    cleanup();
  });

  it("disconnects the observer on cleanup", () => {
    render();
    cleanup = mountStickyContact(document);
    cleanup();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(sticky()).toBe(false);
  });

  it("ships a real, tracked WhatsApp link that is hidden on desktop", () => {
    const page = readFileSync(
      new NodeURL("./pages/index.astro", import.meta.url),
      "utf8",
    );
    expect(page).toMatch(
      /<div class="sticky-contact" data-track-position="fixo">\s*<a class="button button-wine" href=\{config\.contactUrl\}>\{contactLabel\}/,
    );
    const css = readFileSync(
      new NodeURL("./styles/landing.css", import.meta.url),
      "utf8",
    );
    expect(css).toMatch(/\.sticky-contact \{\s*display: none;/);
    expect(css).toContain("env(safe-area-inset-bottom)");
  });
});
