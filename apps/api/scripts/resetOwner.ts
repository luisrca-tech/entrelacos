import { fileURLToPath } from "node:url";
import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  readOwnerRecoveryEnvironment,
  resetOwnerPassword,
} from "../src/ownerRecovery";

export async function runResetOwner(env: NodeJS.ProcessEnv): Promise<void> {
  const recovery = readOwnerRecoveryEnvironment(env);
  const connection = createDatabaseConnection({ target: recovery.target });
  try {
    await verifyDatabaseConnection(connection);
    await resetOwnerPassword(connection.db, {
      email: recovery.email,
      password: recovery.password,
    });
  } finally {
    await connection.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runResetOwner(process.env).catch(() => {
    process.exitCode = 1;
  });
}
