import { fileURLToPath } from "node:url";
import { runDatabaseMigrations } from "../src/connection.ts";

const migrationsFolder = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

try {
  await runDatabaseMigrations({ migrationsFolder });
  console.log("Database migrations completed");
} catch {
  console.error("Database migrations failed");
  process.exitCode = 1;
}
