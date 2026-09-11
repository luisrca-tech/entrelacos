import { fileURLToPath } from "node:url";
import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { bootstrapOwner } from "../src/bootstrapOwner";

export async function runBootstrapOwner(env: NodeJS.ProcessEnv) {
  const target = env.ENTRELACOS_DATABASE_TARGET;
  const email = env.ENTRELACOS_OWNER_EMAIL;
  const name = env.ENTRELACOS_OWNER_NAME;
  const password = env.ENTRELACOS_OWNER_PASSWORD;
  if (
    (target !== "test" && target !== "development") ||
    !email ||
    !name ||
    !password
  )
    throw new Error(
      "Complete non-production owner bootstrap configuration is required",
    );
  const connection = createDatabaseConnection({ target, env });
  try {
    await verifyDatabaseConnection(connection);
    return await bootstrapOwner(connection.db, { email, name, password });
  } finally {
    await connection.close();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runBootstrapOwner(process.env)
    .then(({ created }) =>
      console.log(created ? "Owner created" : "Existing owner preserved"),
    )
    .catch(() => {
      console.error(
        "Owner bootstrap failed; verify private configuration and database identity",
      );
      process.exitCode = 1;
    });
}
