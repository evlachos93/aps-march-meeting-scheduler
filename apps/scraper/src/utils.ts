export const CONCURRENCY = Number(process.env.SCRAPER_CONCURRENCY ?? 10);

/**
 * Processes `items` with at most `concurrency` async workers running simultaneously.
 *
 * Workers claim items via a shared index that is incremented synchronously (before
 * any `await`), so the single-threaded JS event loop guarantees no two workers ever
 * receive the same item.
 */
export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));

  return results;
}
