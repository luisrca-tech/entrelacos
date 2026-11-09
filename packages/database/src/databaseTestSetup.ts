import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createDatabaseConnection,
  isLocalDatabaseUrl,
  verifyDatabaseConnection,
} from "./connection";

export default async function setup() {
  const connection = createDatabaseConnection({ target: "test" });
  try {
    try {
      await verifyDatabaseConnection(connection);
    } catch {
      throw new Error(
        "Integration database identity verification failed; tests were not started.",
      );
    }
    if (isLocalDatabaseUrl(connection.config.url)) {
      execFileSync("bun", ["--no-env-file", "run", "db:migrate"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          ...process.env,
          DATABASE_URL: connection.config.url,
          DATABASE_DIRECT_URL: connection.config.url,
          DATABASE_MIGRATION_HOST: undefined,
        },
        stdio: "inherit",
      });
    }
  } finally {
    await connection.close();
  }
}
