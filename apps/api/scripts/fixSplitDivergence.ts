/**
 * Operator fix for a PLATFORM_ACCOUNT_SPLIT_V2 gift charge whose fixed couple
 * split Asaas blocked with PAYMENT_SPLIT_DIVERGENCE_BLOCK (the charge's net
 * value is below the split frozen in the quote snapshot).
 *
 *   fit   = min(frozen split of the charge, netValue)
 *   topUp = frozen split - fit
 *
 * Dry-run by default: reads the charge with the platform key and the stored V2
 * record, then prints the plan. With `--apply` it edits the charge split to
 * `[{ walletId: couple, fixedValue: fit }]` (Asaas accepts a split-only edit on
 * CONFIRMED/RECEIVED charges during a divergence block), re-reads it, records
 * topUp in gift_payment_record.platform_adjustment_cents and resolves the
 * SPLIT_DIVERGENCE_BLOCK alert. Posting then credits the lowered split on
 * PAYMENT_SPLIT_DONE and the adjustment worker transfers topUp from the
 * platform account to the couple wallet (description SPLIT_DIVERGENCE_TOPUP).
 * Re-running after a partial failure converges and never edits twice.
 *
 * Env loading: ASAAS_API_KEY starts with `$aact_` and Bun's dotenv loader
 * expands `$` sequences, corrupting it. Run with Node's loader through tsx,
 * never `bun run`:
 *
 *   cd apps/api
 *   node_modules/.bin/tsx --env-file=.env scripts/fixSplitDivergence.ts --payment pay_123
 *   node_modules/.bin/tsx --env-file=.env scripts/fixSplitDivergence.ts --payment pay_123 --apply
 *
 * (Add `--env-file=../../packages/database/.env` when the database URLs live
 * there.) In production inject the environment from the secret store.
 *
 * Required env: APP_ENV (development | production) selecting the database,
 * ASAAS_MODE matching it (development -> sandbox, production -> live), the
 * platform key ASAAS_API_KEY (`$aact_hmlg_` Sandbox / `$aact_prod_` live),
 * ASAAS_PLATFORM_WALLET_ID and the rest of the contract read by
 * readGiftPaymentConfig. Outside Railway (a local run) only Sandbox is allowed.
 *
 * Output never contains the API key.
 */
import { fileURLToPath } from "node:url";
import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { readGiftPaymentConfig } from "../src/giftPaymentConfig";
import {
  assertPaymentReference,
  createSplitDivergenceStore,
  fixSplitDivergence,
  SplitDivergenceFixError,
} from "../src/splitDivergenceFix";

export async function runFixSplitDivergence(
  env: NodeJS.ProcessEnv,
  input: { paymentReference: string; apply: boolean },
  fetch: typeof globalThis.fetch = globalThis.fetch,
) {
  const target = env.APP_ENV;
  if (target !== "development" && target !== "production")
    throw new SplitDivergenceFixError("CONFIGURATION_INVALID");
  if (env.RAILWAY_ENVIRONMENT_NAME && env.RAILWAY_ENVIRONMENT_NAME !== target)
    throw new SplitDivergenceFixError("CONFIGURATION_INVALID");
  let config: ReturnType<typeof readGiftPaymentConfig>;
  try {
    config = readGiftPaymentConfig(env, target);
  } catch {
    throw new SplitDivergenceFixError("CONFIGURATION_INVALID");
  }
  if (
    config.mode === "disabled" ||
    (target === "production" && config.mode !== "live") ||
    (target === "development" && config.mode !== "sandbox") ||
    // A local run (outside Railway) may only touch the Sandbox.
    (!env.RAILWAY_ENVIRONMENT_NAME && config.mode !== "sandbox")
  )
    throw new SplitDivergenceFixError("CONFIGURATION_INVALID");
  const paymentReference = assertPaymentReference(input.paymentReference);
  const connection = createDatabaseConnection({ target, env });
  try {
    await verifyDatabaseConnection(connection);
    return await fixSplitDivergence(
      createSplitDivergenceStore(connection.db, config.mode),
      {
        environment: config.mode,
        platformApiKey: config.platformApiKey,
        platformWalletId: config.platformWalletId,
        fetch,
      },
      { paymentReference, apply: input.apply },
    );
  } finally {
    await connection.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--payment");
  const paymentReference = index === -1 ? "" : (process.argv[index + 1] ?? "");
  const apply = process.argv.includes("--apply");
  runFixSplitDivergence(process.env, { paymentReference, apply }).then(
    (result) => {
      console.log(JSON.stringify(result, null, 2));
      if (!result.applied)
        console.log(
          result.plan.splitUpdateRequired || result.plan.topUpCents > 0
            ? "Dry run: nothing changed. Re-run with --apply to perform it."
            : "Dry run: the split already fits; --apply would only resolve the alert.",
        );
    },
    (error: unknown) => {
      // Only the refusal code is printed; never the configuration or the key.
      console.error(
        error instanceof SplitDivergenceFixError
          ? error.message
          : "Split divergence fix failed",
      );
      process.exitCode = 1;
    },
  );
}
