import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it, vi } from "vitest";
import { createWithdrawalComposition } from "./withdrawalComposition";
import * as withdrawalExecution from "./withdrawalExecution";

it("persists a recovery deadline before provider I/O and resumes it across workers", async () => {
  const connection = createDatabaseConnection({ target: "test" });
  try {
    await verifyDatabaseConnection(connection);
    const client = await connection.pool.connect();
    try {
      await client.query(`
        CREATE TEMP TABLE site (id text PRIMARY KEY, is_demo bool);
        CREATE TEMP TABLE withdrawal_intent (
          id text PRIMARY KEY, site_id text, account_id text, environment text, state text, request_id text
        );
        CREATE TEMP TABLE financial_operation (
          id text PRIMARY KEY, site_id text, account_id text, environment text, state text, kind text,
          attempts integer, withdrawal_intent_id text, next_attempt_at timestamptz, lease_expires_at timestamptz
        );
        INSERT INTO site VALUES ('site-one', false);
        INSERT INTO withdrawal_intent VALUES
          ('unknown', 'site-one', 'account-one', 'sandbox', 'UNKNOWN', 'request-one'),
          ('requested', 'site-one', 'account-one', 'sandbox', 'REQUESTED', 'request-two'),
          ('dispatching', 'site-one', 'account-one', 'sandbox', 'PROCESSING', 'request-three');
        INSERT INTO financial_operation VALUES
          ('one', 'site-one', 'account-one', 'sandbox', 'UNKNOWN', 'WITHDRAWAL', 1, 'unknown', '2000-01-01Z', '2000-01-02Z'),
          ('two', 'site-one', 'account-one', 'sandbox', 'REQUESTED', 'WITHDRAWAL', 0, 'requested', '1999-01-01Z', NULL),
          ('three', 'site-one', 'account-one', 'sandbox', 'PROCESSING', 'WITHDRAWAL', 1, 'dispatching', '2000-01-01Z', clock_timestamp()+interval '1 hour');
      `);
      let release = () => {};
      const providerPending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let begin = () => {};
      const providerStarted = new Promise<void>((resolve) => {
        begin = resolve;
      });
      const reconcileExisting = vi.fn(async () => {
        begin();
        await providerPending;
        return { outcome: "UNRESOLVED" } as const;
      });
      const executeExisting = vi.fn();
      const execution = vi
        .spyOn(withdrawalExecution, "createWithdrawalExecutionService")
        .mockReturnValue({ reconcileExisting, executeExisting });
      const fetch = vi.fn<typeof globalThis.fetch>();
      const createWorker = () =>
        createWithdrawalComposition(
          {
            mode: "sandbox",
            applicationEnvironment: "test",
            platformApiKey: "$aact_hmlg_fixture",
            platformAccountId: "platform-one",
            platformWalletId: "wallet-one",
            credentialKeyId: "test-key",
            credentialKeyring: new Map([["test-key", new Uint8Array(32)]]),
            webhookPublicOrigin: "https://webhook.example.test",
            webhookUrl: "https://webhook.example.test/v1/webhooks/asaas",
          },
          { db: drizzle(client), fetch },
        );
      const first = createWorker();
      const restarted = createWorker();
      try {
        await expect(first.nextRecoveryDueAt()).resolves.toBe(
          Date.UTC(2000, 0, 2),
        );
        const recovering = first.reconcilePending();
        await Promise.race([providerStarted, recovering]);
        expect(reconcileExisting).toHaveBeenCalledExactlyOnceWith({
          siteId: "site-one",
          requestId: "request-one",
        });
        const retry = await client.query(
          `SELECT ceil(extract(epoch FROM next_attempt_at)*1000)::float8 AS deadline
           FROM financial_operation WHERE id='one'`,
        );
        expect(retry.rows[0].deadline).toBeGreaterThan(Date.now());
        await expect(restarted.nextRecoveryDueAt()).resolves.toBe(
          retry.rows[0].deadline,
        );
        await expect(restarted.reconcilePending()).resolves.toEqual({
          kind: "IDLE",
        });
        release();
        await expect(recovering).resolves.toEqual({ kind: "OBSERVED" });
        const rescheduled = await restarted.nextRecoveryDueAt();
        expect(rescheduled).toBeGreaterThan(retry.rows[0].deadline);
        expect(reconcileExisting).toHaveBeenCalledOnce();
        expect(executeExisting).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        release();
        await Promise.all([first.close(), restarted.close()]);
        execution.mockRestore();
      }
    } finally {
      client.release(true);
    }
  } finally {
    await connection.close();
  }
});
