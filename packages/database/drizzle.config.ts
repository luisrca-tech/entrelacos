import { defineConfig } from "drizzle-kit";
import { resolveMigrationConnectionUrl } from "./src/connection";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  strict: true,
  ...(process.env.DATABASE_URL
    ? { dbCredentials: { url: resolveMigrationConnectionUrl() } }
    : {}),
});
