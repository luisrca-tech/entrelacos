import type { DatabaseConnection } from "@entrelacos/database";
import {
  giftQuoteRecord,
  receivingAccount,
  receivingDestination,
} from "@entrelacos/database/schema";
import { and, eq } from "drizzle-orm";
import { readGiftQuoteSnapshot } from "./giftCheckouts";
import type { GiftQuoteSnapshot } from "./giftQuotes";

type QuoteDatabase = Pick<DatabaseConnection["db"], "transaction">;
export class GiftQuoteRepositoryError extends Error {
  readonly status = 503;
  readonly code = "QUOTE_STORAGE_UNAVAILABLE";
  constructor() {
    super("Gift quote persistence unavailable");
    this.name = "GiftQuoteRepositoryError";
  }
}
function unavailable(): never {
  throw new GiftQuoteRepositoryError();
}
export function createGiftQuoteRepository(
  db: QuoteDatabase,
  options: { now(): Date },
) {
  return {
    async append(input: GiftQuoteSnapshot): Promise<void> {
      try {
        const snapshot = readGiftQuoteSnapshot(input);
        const binding = snapshot.receiving;
        const assertFresh = () => {
          const observed = options.now();
          if (
            !(observed instanceof Date) ||
            !Number.isFinite(observed.getTime()) ||
            Date.parse(snapshot.createdAt) > observed.getTime() ||
            Date.parse(snapshot.expiresAt) <= observed.getTime()
          )
            unavailable();
        };
        if (binding.provider !== "ASAAS") unavailable();
        assertFresh();
        await db.transaction(async (tx) => {
          const accounts = await tx
            .select({
              id: receivingAccount.id,
              siteId: receivingAccount.siteId,
              provider: receivingAccount.provider,
              environment: receivingAccount.environment,
              accountReference: receivingAccount.accountReference,
              operatorReference: receivingAccount.operatorReference,
              recipientReference: receivingAccount.recipientReference,
              isCurrent: receivingAccount.isCurrent,
            })
            .from(receivingAccount)
            .where(
              and(
                eq(receivingAccount.siteId, binding.siteId),
                eq(receivingAccount.environment, binding.environment),
                eq(receivingAccount.provider, "ASAAS"),
                eq(receivingAccount.accountReference, binding.accountReference),
                eq(receivingAccount.isCurrent, true),
              ),
            )
            .for("share")
            .limit(2);
          const account = accounts[0];
          if (
            accounts.length !== 1 ||
            !account ||
            typeof account.id !== "string" ||
            !account.id ||
            account.siteId !== binding.siteId ||
            account.provider !== binding.provider ||
            account.environment !== binding.environment ||
            account.accountReference !== binding.accountReference ||
            account.operatorReference !== binding.operatorReference ||
            account.recipientReference !== binding.recipientReference ||
            account.isCurrent !== true
          )
            unavailable();
          const destinations = await tx
            .select({
              siteId: receivingDestination.siteId,
              accountId: receivingDestination.accountId,
              environment: receivingDestination.environment,
              version: receivingDestination.version,
              bankReference: receivingDestination.bankReference,
              isCurrent: receivingDestination.isCurrent,
            })
            .from(receivingDestination)
            .where(
              and(
                eq(receivingDestination.siteId, binding.siteId),
                eq(receivingDestination.accountId, account.id),
                eq(receivingDestination.environment, binding.environment),
                eq(receivingDestination.version, binding.destinationVersion),
                eq(receivingDestination.isCurrent, true),
              ),
            )
            .for("share")
            .limit(2);
          const destination = destinations[0];
          if (
            destinations.length !== 1 ||
            !destination ||
            destination.siteId !== binding.siteId ||
            destination.accountId !== account.id ||
            destination.environment !== binding.environment ||
            destination.version !== binding.destinationVersion ||
            destination.bankReference !== binding.bankReference ||
            destination.isCurrent !== true
          )
            unavailable();
          assertFresh();
          const quote = snapshot.quote;
          const inserted = await tx
            .insert(giftQuoteRecord)
            .values({
              id: quote.id,
              siteId: quote.siteId,
              accountId: account.id,
              environment: binding.environment,
              giftId: quote.giftId,
              destinationVersion: binding.destinationVersion,
              method: quote.method,
              currency: quote.currency,
              nominalCents: quote.nominalCents,
              commissionBasisPoints: quote.commissionBasisPoints,
              commissionCents: quote.commissionCents,
              processingCents: quote.processingCents,
              totalCents: quote.totalCents,
              policyVersion: quote.policyVersion,
              snapshot: { ...snapshot },
              createdAt: new Date(snapshot.createdAt),
              expiresAt: new Date(snapshot.expiresAt),
            })
            .returning({ id: giftQuoteRecord.id });
          if (inserted.length !== 1 || inserted[0].id !== quote.id)
            unavailable();
        });
      } catch {
        unavailable();
      }
    },
  };
}
