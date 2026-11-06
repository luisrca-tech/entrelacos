import { expect, it } from "vitest";
import { mapWithConcurrency } from "./mapWithConcurrency";

it("keeps input order while never exceeding the concurrency limit", async () => {
  let running = 0;
  let peak = 0;
  const result = await mapWithConcurrency([5, 1, 4, 2, 3, 0], 2, async (n) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, n));
    running -= 1;
    return n * 10;
  });
  expect(result).toEqual([50, 10, 40, 20, 30, 0]);
  expect(peak).toBe(2);
});

it("rejects with the first failure and returns an empty list for no items", async () => {
  await expect(mapWithConcurrency([], 3, async () => 1)).resolves.toEqual([]);
  await expect(
    mapWithConcurrency([1, 2], 2, async (n) => {
      if (n === 2) throw new Error("unavailable");
      return n;
    }),
  ).rejects.toThrow("unavailable");
});
