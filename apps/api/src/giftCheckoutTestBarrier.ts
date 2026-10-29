import type { GiftCheckoutDatabase } from "./giftCheckoutRepository";

// Test-only transaction barrier shared by offline ordering and PostgreSQL acceptance.
export function beforeWriteCommitDatabase(
  db: GiftCheckoutDatabase,
  started: { release(): void },
  release: { promise: Promise<void> },
): GiftCheckoutDatabase {
  return {
    execute: db.execute.bind(db),
    transaction: async (callback, config) =>
      db.transaction(async (tx) => {
        const result = await callback(tx);
        if (config?.accessMode !== "read only") {
          started.release();
          await release.promise;
        }
        return result;
      }, config),
  };
}
