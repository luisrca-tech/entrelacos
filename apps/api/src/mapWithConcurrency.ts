/**
 * Maps items with an async function, running at most `limit` calls at once and
 * preserving input order. Used where each item needs its own database work so a
 * full page cannot exhaust the connection pool.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index] as T);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker),
  );
  return results;
}
