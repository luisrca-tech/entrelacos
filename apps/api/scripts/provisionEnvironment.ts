import { fileURLToPath } from "node:url";
import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  type EnvironmentProvisionInput,
  provisionDemoEnvironment,
} from "../src/environmentProvision";

function requiredEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
  preserveWhitespace = false,
): string {
  const raw = env[name];
  if (!raw?.trim())
    throw new Error(
      "Complete environment provisioning configuration is required",
    );
  return preserveWhitespace ? raw : raw.trim();
}

function readInput(env: NodeJS.ProcessEnv): EnvironmentProvisionInput {
  const target = requiredEnvironmentValue(env, "ENTRELACOS_DATABASE_TARGET");
  if (target !== "development" && target !== "production") {
    throw new Error(
      "Environment provisioning target must be development or production",
    );
  }

  const runtimeEnvironment = requiredEnvironmentValue(
    env,
    "RAILWAY_ENVIRONMENT_NAME",
  );
  if (runtimeEnvironment !== target) {
    throw new Error("Railway environment does not match database target");
  }

  const confirmation = requiredEnvironmentValue(
    env,
    "ENTRELACOS_PROVISION_CONFIRM",
  );
  if (confirmation !== `PROVISION ${target} demo-wedding`) {
    throw new Error("Exact environment provisioning confirmation is required");
  }

  const productionAuthorization =
    env.ENTRELACOS_PRODUCTION_PROVISION_AUTHORIZED?.trim() ?? "";
  if (
    target === "production" &&
    productionAuthorization !== "PROVISION production environment"
  ) {
    throw new Error(
      "Explicit production provisioning authorization is required",
    );
  }

  const resetConfirmation = env.ENTRELACOS_DEMO_RESET_CONFIRM?.trim() ?? "";
  const expectedResetConfirmation = `RESET ${target} demo-wedding`;
  if (resetConfirmation && resetConfirmation !== expectedResetConfirmation) {
    throw new Error("Exact demo reset confirmation is required");
  }

  return {
    target,
    runtimeEnvironment,
    productionAuthorized:
      target === "production" &&
      productionAuthorization === "PROVISION production environment",
    resetAuthorized: resetConfirmation === expectedResetConfirmation,
    owner: {
      email: requiredEnvironmentValue(env, "ENTRELACOS_OWNER_EMAIL"),
      name: requiredEnvironmentValue(env, "ENTRELACOS_OWNER_NAME"),
      password: requiredEnvironmentValue(
        env,
        "ENTRELACOS_OWNER_PASSWORD",
        true,
      ),
    },
    publicUrl: requiredEnvironmentValue(env, "ENTRELACOS_DEMO_PUBLIC_URL"),
  };
}

export async function runEnvironmentProvision(env: NodeJS.ProcessEnv) {
  const input = readInput(env);
  const connection = createDatabaseConnection({ target: input.target, env });
  try {
    await verifyDatabaseConnection(connection);
    return await provisionDemoEnvironment(connection.db, input);
  } finally {
    await connection.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runEnvironmentProvision(process.env)
    .then(({ site, reset }) =>
      console.log(
        `${site === "created" ? "Demo site created" : "Existing demo site preserved"}; ${reset ? "Demo dataset reset" : "Demo dataset preserved"}`,
      ),
    )
    .catch(() => {
      console.error(
        "Environment provisioning failed; verify private configuration and database identity",
      );
      process.exitCode = 1;
    });
}
