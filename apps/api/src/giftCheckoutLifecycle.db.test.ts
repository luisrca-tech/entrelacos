import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { drizzle } from "drizzle-orm/node-postgres";
import { it } from "vitest";
import { createGiftCheckoutLifecycleWorker } from "./giftCheckoutLifecycle";

it("fences expiry with durable payment references across a lost provider response", async () => {
  const connection = createDatabaseConnection({ target: "test" });
  try {
    await verifyDatabaseConnection(connection);
    const client = await connection.pool.connect();
    try {
      const db = drizzle(client);
      await client.query(`
      CREATE TEMP TABLE site (id text, is_demo bool);
      CREATE TEMP TABLE receiving_account (id text, site_id text, environment text, provider text, account_reference text);
      CREATE TEMP TABLE gift_order (id text, site_id text, account_id text, environment text, quote_id text);
      CREATE TEMP TABLE gift_quote_record (id text, site_id text, account_id text, environment text, method text, snapshot jsonb);
      CREATE TEMP TABLE gift_checkout_attempt (id text, site_id text, account_id text, environment text, order_id text, operation_id text, operation_kind text, provider_reference text, hosted_url text);
      CREATE TEMP TABLE financial_operation (id text, site_id text, account_id text, environment text, order_id text, kind text, provider_operation_reference text, state text, updated_at timestamptz, next_attempt_at timestamptz, last_error_code text);
      CREATE TEMP TABLE gift_payment_record (id text, site_id text, account_id text, environment text, order_id text, attempt_id text, provider_payment_reference text, provider_installment_reference text, verification_status text, provider_status text);
      CREATE TEMP TABLE financial_ledger_entry (site_id text, account_id text, environment text, operation_id text, payment_id text);
      CREATE TEMP TABLE financial_event_inbox (site_id text, account_id text, environment text, payload jsonb, event_type text, state text, last_error_code text, authenticated_at timestamptz);
      INSERT INTO site VALUES ('site-one', true);
      INSERT INTO receiving_account VALUES ('account-one','site-one','sandbox','ASAAS','remote-one');
      INSERT INTO gift_order VALUES ('order-one','site-one','account-one','sandbox','quote-one');
      INSERT INTO gift_checkout_attempt VALUES ('attempt-one','site-one','account-one','sandbox','order-one','attempt-one','CHECKOUT_CREATE','plan_one','https://sandbox.asaas.com/i/test');
      INSERT INTO financial_operation VALUES ('attempt-one','site-one','account-one','sandbox','order-one','CHECKOUT_CREATE','plan_one','SUCCEEDED',clock_timestamp()-interval '59 minutes',clock_timestamp()-interval '59 minutes',NULL);
    `);
      await client.query(
        readFileSync(
          new URL(
            "../../../packages/database/migrations/0029_gift_installment_expiry.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const one = {
        installmentCount: 1,
        totalCents: 10239,
        installmentSurchargeCents: 0,
        installmentCents: [10239],
      };
      const two = {
        installmentCount: 2,
        totalCents: 10239,
        installmentSurchargeCents: 0,
        installmentCents: [5119, 5120],
      };
      const quote = {
        ...two,
        id: "quote-one",
        giftId: "gift-one",
        siteId: "site-one",
        mode: "sandbox",
        title: "A contribution",
        method: "CREDIT_CARD",
        currency: "BRL",
        nominalCents: 10000,
        commissionBasisPoints: 200,
        commissionCents: 200,
        processingCents: 39,
        feeAllocation: "BUYER_GROSS_UP",
        settlementVersion: "PLATFORM_FEE_GUARANTEE_V1",
        installmentOptions: [one, two],
        policyVersion: "test-one",
        expiresAt: new Date().toISOString(),
      };
      await client.query(
        "INSERT INTO gift_quote_record VALUES ('quote-one','site-one','account-one','sandbox','CREDIT_CARD',$1)",
        [
          JSON.stringify({
            quote,
            receiving: { accountReference: "remote-one" },
          }),
        ],
      );
      let nativeReads = 0,
        removalCount = 0,
        lateReceipt = false;
      const worker = createGiftCheckoutLifecycleWorker({
        db,
        environment: "sandbox",
        instanceId: "worker-one",
        now: () => new Date(),
        reader: {
          listCheckoutPayments: async () => {
            throw new Error("unexpected hosted checkout");
          },
          getInstallmentRemoval: async (binding, installmentReference) => ({
            ...binding,
            source: "provider",
            installmentReference,
            observedAt: new Date(),
            removed: removalCount > 0,
          }),
          async listInstallmentPayments(binding, installmentReference) {
            nativeReads++;
            if (lateReceipt)
              await client.query(
                "INSERT INTO financial_event_inbox VALUES ('site-one','account-one','sandbox',$1, 'PAYMENT_CONFIRMED','RECEIVED',NULL,clock_timestamp())",
                [JSON.stringify({ paymentId: "pay_two" })],
              );
            return {
              ...binding,
              source: "provider",
              installmentReference,
              observedAt: new Date(),
              payments: [
                { id: "pay_one", value: "51.19", installmentNumber: 1 },
                { id: "pay_two", value: "51.20", installmentNumber: 2 },
              ].map((p) => ({
                ...p,
                installment: installmentReference,
                externalReference: "attempt-one",
                billingType: "CREDIT_CARD",
                status: "PENDING",
              })),
            };
          },
          async removeInstallment(binding, reference) {
            assert.equal(binding.accountReference, "remote-one");
            assert.equal(reference, "plan_one");
            removalCount++;
            throw new Error("Simulated DELETE response loss");
          },
        },
      });
      assert.deepEqual(await worker.expireNextUnpaidInstallment(), {
        kind: "IDLE",
      });
      assert.equal(nativeReads, 0);
      await client.query(
        "UPDATE financial_operation SET updated_at=clock_timestamp()-interval '61 minutes'",
      );
      await client.query(
        "INSERT INTO gift_payment_record VALUES ('payment-one','site-one','account-one','sandbox','order-one','attempt-one','pay_one','plan_one','VERIFIED','PENDING')",
      );
      lateReceipt = true;
      assert.deepEqual(await worker.expireNextUnpaidInstallment(), {
        kind: "RETRY",
      });
      assert.equal(removalCount, 0);
      await client.query(
        "DELETE FROM financial_event_inbox; UPDATE financial_operation SET next_attempt_at=clock_timestamp()",
      );
      lateReceipt = false;
      await client.query(`
        CREATE FUNCTION pg_temp.block_expiry_marker() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.last_error_code = 'INSTALLMENT_EXPIRY_DISPATCHED'
            AND current_setting('test.block_expiry_marker', true) = 'on'
          THEN
            RAISE EXCEPTION 'Simulated expiry marker write failure';
          END IF;
          RETURN NEW;
        END
        $$;
        CREATE TRIGGER block_expiry_marker BEFORE UPDATE ON financial_operation
          FOR EACH ROW EXECUTE FUNCTION pg_temp.block_expiry_marker();
        SELECT set_config('test.block_expiry_marker', 'on', false);
      `);
      await assert.rejects(
        () => worker.expireNextUnpaidInstallment(),
        /Failed query/,
      );
      assert.deepEqual(
        (
          await client.query(`
        SELECT op.last_error_code, a.installment_expiry_payment_references
        FROM financial_operation op JOIN gift_checkout_attempt a ON a.operation_id=op.id
      `)
        ).rows,
        [
          {
            last_error_code: null,
            installment_expiry_payment_references: null,
          },
        ],
      );
      assert.equal(removalCount, 0);
      await client.query(`
        SELECT set_config('test.block_expiry_marker', 'off', false);
        UPDATE financial_operation SET next_attempt_at=clock_timestamp();
      `);
      await assert.rejects(
        () => worker.expireNextUnpaidInstallment(),
        /Simulated DELETE response loss/,
      );
      assert.equal(
        (await client.query("SELECT last_error_code FROM financial_operation"))
          .rows[0].last_error_code,
        "INSTALLMENT_EXPIRY_DISPATCHED",
      );
      assert.deepEqual(
        (
          await client.query(
            "SELECT installment_expiry_payment_references FROM gift_checkout_attempt",
          )
        ).rows,
        [{ installment_expiry_payment_references: ["pay_one", "pay_two"] }],
      );
      await client.query(
        "UPDATE financial_operation SET next_attempt_at=clock_timestamp()",
      );
      await client.query(
        "INSERT INTO financial_event_inbox VALUES ('site-one','account-one','sandbox',$1,'PAYMENT_AWAITING_CHARGEBACK_REVERSAL','RECEIVED',NULL,clock_timestamp())",
        [JSON.stringify({ paymentId: "pay_two" })],
      );
      assert.deepEqual(await worker.expireNextUnpaidInstallment(), {
        kind: "IDLE",
      });
      assert.equal(removalCount, 1);
      assert.equal(
        (await client.query("SELECT last_error_code FROM financial_operation"))
          .rows[0].last_error_code,
        "INSTALLMENT_EXPIRY_DISPATCHED",
      );
      await client.query("DELETE FROM financial_event_inbox");
      await client.query(
        "UPDATE financial_operation SET next_attempt_at=clock_timestamp()",
      );
      assert.deepEqual(await worker.expireNextUnpaidInstallment(), {
        kind: "OBSERVED",
      });
      assert.deepEqual(await worker.expireNextUnpaidInstallment(), {
        kind: "IDLE",
      });
      assert.equal(removalCount, 1);
      assert.equal(nativeReads, 3);
      const saved = await client.query(
        "SELECT state, last_error_code, next_attempt_at > clock_timestamp() AS cooldown FROM financial_operation",
      );
      assert.deepEqual(saved.rows, [
        {
          state: "SUCCEEDED",
          last_error_code: "INSTALLMENT_EXPIRY_CONFIRMED",
          cooldown: true,
        },
      ]);
    } finally {
      client.release(true);
    }
  } finally {
    await connection.close();
  }
});
