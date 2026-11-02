import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
it.each([
  "https://demo-cartas.entrelacos.workers.dev",
  "https://demo-cartas.entrelacos.workers.dev/",
])("normalizes canonical and social paths for %s", async (base) => {
  vi.stubEnv("PUBLIC_SITE_URL", base);
  const { seo } = await import("./demoContent");
  expect(seo.canonical).toBe("https://demo-cartas.entrelacos.workers.dev/");
  expect(seo.socialImage.url).toBe(
    "https://demo-cartas.entrelacos.workers.dev/marina-caio-gallery-three.webp",
  );
});
