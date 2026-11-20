import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  isLocalDatabaseUrl,
  verifyDatabaseConnection,
} from "./connection";

// Production holds rows written before the Pagar.me switch (provider
// "ASAAS", encrypted sub-account credentials, transfer observations, Pix
// preparation fences). This applies 0000–0030 to a scratch database, seeds
// those rows, then applies the rest and checks that nothing was lost.
const migrations = fileURLToPath(new URL("../migrations", import.meta.url));
const legacyProvider = "ASAAS";
let admin: DatabaseConnection;
let scratch: Pool | undefined;
let folder = "";
const scratches: Array<{ name: string; pool: Pool }> = [];

async function scratchDatabase(): Promise<Pool> {
  const name = `entrelacos_legacy_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  const url = new URL(admin.config.url);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString() });
  scratches.push({ name, pool });
  return pool;
}

function migrationsUpTo(lastTag: string): string {
  const journal = JSON.parse(
    readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
  );
  const index = journal.entries.findIndex(
    (entry: { tag: string }) => entry.tag === lastTag,
  );
  if (index < 0) throw new Error(`Missing migration ${lastTag}`);
  const target = mkdtempSync(join(tmpdir(), "legacy-migrations-"));
  cpSync(migrations, target, { recursive: true });
  writeFileSync(
    join(target, "meta/_journal.json"),
    JSON.stringify({
      ...journal,
      entries: journal.entries.slice(0, index + 1),
    }),
  );
  return target;
}

beforeAll(async () => {
  admin = createDatabaseConnection({ target: "test" });
  await verifyDatabaseConnection(admin);
  if (!isLocalDatabaseUrl(admin.config.url))
    throw new Error("Scratch migration databases are created only locally");
  scratch = await scratchDatabase();
  folder = migrationsUpTo("0030_platform_account_split");
});

afterAll(async () => {
  for (const { name, pool } of scratches) {
    await pool.end();
    await admin?.pool.query(`DROP DATABASE IF EXISTS "${name}"`);
  }
  await admin?.close();
  if (folder) rmSync(folder, { recursive: true, force: true });
});

describe("Pagar.me migrations over Asaas-era rows", () => {
  it("keeps every legacy row and credential, and still accepts Pagar.me rows", async () => {
    if (!scratch) throw new Error("Scratch database unavailable");
    const db = drizzle(scratch);
    await migrate(db, { migrationsFolder: folder });
    const q = (text: string, values: unknown[] = []) =>
      (scratch as Pool).query(text, values);
    const userId = randomUUID();
    const siteId = randomUUID();
    const accountId = randomUUID();
    const operationId = randomUUID();
    const hash = "a".repeat(64);
    await q(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Legacy', $2)`, [
      userId,
      `${userId}@example.test`,
    ]);
    await q(
      `INSERT INTO site (id, repository_slug, provisioning_key, display_name, partner_one_name, partner_two_name, event_date)
       VALUES ($1, $2, $3, 'Demo Botânico', 'A', 'B', '2027-05-22')`,
      [siteId, `legacy-${siteId}`, `legacy:${siteId}`],
    );
    await q(
      `INSERT INTO receiving_account (id, site_id, environment, provider, operator_user_id, account_reference,
         is_current, credential_version, credential_key_id, credential_nonce, credential_ciphertext, credential_tag,
         webhook_token_hash, webhook_registration)
       VALUES ($1, $2, 'live', $3, $4, 'acc_legacy', true, 1, 'key-1', 'nonce', 'ciphertext', 'tag', $5, '{"id":"wh_1"}')`,
      [accountId, siteId, legacyProvider, userId, hash],
    );
    await q(
      `INSERT INTO financial_operation (id, site_id, account_id, environment, kind, request_id, request_hash, request_snapshot)
       VALUES ($1, $2, $3, 'live', 'ACCOUNT_CREATE', 'legacy-request', $4, '{}')`,
      [operationId, siteId, accountId, hash],
    );
    await q(
      `INSERT INTO withdrawal_provider_observation (id, site_id, account_id, environment, operation_id,
         provider_reference, payload_hash, payload, observed_at)
       VALUES ($1, $2, $3, 'live', $4, 'tra_legacy01', $5, '{}', now())`,
      [`asaas-transfer:${hash}`, siteId, accountId, operationId, hash],
    );
    await q(
      `INSERT INTO receiving_pix_preparation (account_id, site_id, environment, attempt_id, actor_user_id,
         session_id, consent_id, state, attempts, attempted_at, updated_at)
       VALUES ($1, $2, 'live', $3, $4, 'session', 'consent', 'SUBMITTED', 1, now(), now())`,
      [accountId, siteId, randomUUID(), userId],
    );

    await migrate(db, { migrationsFolder: migrations });

    // 0033 is a no-op where 0031 kept the checks: they stay validated.
    expect(
      (
        await q(
          `SELECT conname, convalidated FROM pg_constraint
           WHERE conname IN ('receiving_account_credentials_check', 'receiving_account_webhook_hash_check')
           ORDER BY conname`,
        )
      ).rows,
    ).toEqual([
      { conname: "receiving_account_credentials_check", convalidated: true },
      { conname: "receiving_account_webhook_hash_check", convalidated: true },
    ]);

    const account = await q(
      `SELECT provider, is_current, credential_version, credential_key_id, credential_nonce,
         credential_ciphertext, credential_tag, webhook_token_hash, webhook_registration
       FROM receiving_account WHERE id = $1`,
      [accountId],
    );
    expect(account.rows).toEqual([
      {
        provider: legacyProvider,
        is_current: true,
        credential_version: 1,
        credential_key_id: "key-1",
        credential_nonce: "nonce",
        credential_ciphertext: "ciphertext",
        credential_tag: "tag",
        webhook_token_hash: hash,
        webhook_registration: { id: "wh_1" },
      },
    ]);
    expect(
      (
        await q(
          "SELECT id FROM withdrawal_provider_observation WHERE site_id = $1",
          [siteId],
        )
      ).rows,
    ).toEqual([{ id: `asaas-transfer:${hash}` }]);
    expect(
      (
        await q(
          "SELECT state FROM receiving_pix_preparation WHERE account_id = $1",
          [accountId],
        )
      ).rows,
    ).toEqual([{ state: "SUBMITTED" }]);
    // New observations must use the Pagar.me namespace.
    await expect(
      q(
        `INSERT INTO withdrawal_provider_observation (id, site_id, account_id, environment, operation_id,
           provider_reference, payload_hash, payload, observed_at)
         VALUES ($1, $2, $3, 'live', $4, 'tra_legacy02', $5, '{}', now())`,
        [
          `asaas-transfer:${"b".repeat(64)}`,
          siteId,
          accountId,
          operationId,
          "b".repeat(64),
        ],
      ),
    ).rejects.toThrow(/withdrawal_observation_hash_check/);
    // A Pagar.me account can be added next to the legacy one.
    await q(`UPDATE receiving_account SET is_current = false WHERE id = $1`, [
      accountId,
    ]);
    await q(
      `INSERT INTO receiving_account (id, site_id, environment, provider, operator_user_id, account_reference,
         recipient_reference, is_current)
       VALUES ($1, $2, 'live', 'PAGARME', $3, 'rp_new0001', 'rp_new0001', true)`,
      [randomUUID(), siteId, userId],
    );
  });

  it("restores the legacy checks without failing on rows a draft left unchecked", async () => {
    // A local database that applied an early 0031 draft can hold rows written
    // while these checks were missing. 0033 adds them NOT VALID so it still
    // applies; new writes are checked.
    const pool = await scratchDatabase();
    const db = drizzle(pool);
    const draft = migrationsUpTo("0032_pagarme_orders");
    try {
      await migrate(db, { migrationsFolder: draft });
    } finally {
      rmSync(draft, { recursive: true, force: true });
    }
    const q = (text: string, values: unknown[] = []) =>
      pool.query(text, values);
    await q(`ALTER TABLE receiving_account
      DROP CONSTRAINT receiving_account_credentials_check,
      DROP CONSTRAINT receiving_account_webhook_hash_check`);
    const userId = randomUUID();
    const siteId = randomUUID();
    await q(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Draft', $2)`, [
      userId,
      `${userId}@example.test`,
    ]);
    await q(
      `INSERT INTO site (id, repository_slug, provisioning_key, display_name, partner_one_name, partner_two_name, event_date)
       VALUES ($1, $2, $3, 'Demo', 'A', 'B', '2027-05-22')`,
      [siteId, `draft-${siteId}`, `draft:${siteId}`],
    );
    await q(
      `INSERT INTO receiving_account (id, site_id, environment, provider, operator_user_id, account_reference,
         is_current, credential_version, webhook_token_hash)
       VALUES ($1, $2, 'sandbox', 'PAGARME', $3, 'rp_draft0001', true, 1, 'not-hex')`,
      [randomUUID(), siteId, userId],
    );

    await migrate(db, { migrationsFolder: migrations });

    expect(
      (
        await q(
          `SELECT conname, convalidated FROM pg_constraint
           WHERE conname IN ('receiving_account_credentials_check', 'receiving_account_webhook_hash_check')
           ORDER BY conname`,
        )
      ).rows,
    ).toEqual([
      { conname: "receiving_account_credentials_check", convalidated: false },
      { conname: "receiving_account_webhook_hash_check", convalidated: false },
    ]);
    await expect(
      q(
        `INSERT INTO receiving_account (id, site_id, environment, provider, operator_user_id, account_reference,
           is_current, webhook_token_hash)
         VALUES ($1, $2, 'sandbox', 'PAGARME', $3, 'rp_draft0002', false, 'not-hex')`,
        [randomUUID(), siteId, userId],
      ),
    ).rejects.toThrow(/receiving_account_webhook_hash_check/);
  });
});
