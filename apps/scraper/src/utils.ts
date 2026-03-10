import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
config({ path: resolve(WORKSPACE_ROOT, ".env") });

const rawConcurrency = process.env.SCRAPER_CONCURRENCY;
export const CONCURRENCY = Number(rawConcurrency ?? 10);
console.log("scraper concurrency", {
  configuredValue: rawConcurrency ?? "<unset>",
  envPath: resolve(WORKSPACE_ROOT, ".env"),
  activeWorkers: CONCURRENCY
});

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
