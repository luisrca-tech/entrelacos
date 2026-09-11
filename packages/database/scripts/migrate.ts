import { fileURLToPath } from "node:url";
import {
  type DatabaseTarget,
  runDatabaseMigrations,
} from "../src/connection.ts";

function readTarget(args: string[]): DatabaseTarget {
  const value = args
    .find((argument) => argument.startsWith("--target="))
    ?.slice("--target=".length);
  if (value !== "development" && value !== "test") {
    throw new Error(
      "Migration target is required: use --target=development or --target=test",
    );
  }
  return value;
}

const target = readTarget(process.argv.slice(2));
const migrationsFolder = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

try {
  await runDatabaseMigrations({ target, migrationsFolder });
  console.log(`Database migrations completed for ${target}`);
} catch {
  console.error(`Database migrations failed for ${target}`);
  process.exitCode = 1;
}
