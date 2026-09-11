// Server-only database boundary. Importing this module does not open a connection.

export { drizzle } from "drizzle-orm/node-postgres";
export { Pool } from "pg";
export type {
  DatabaseConfig,
  DatabaseConnection,
  DatabaseConnectionOptions,
  DatabaseEnvironment,
  DatabaseIdentity,
  DatabaseTarget,
  ExpectedDatabaseIdentity,
} from "./connection";
export {
  assertDatabaseIdentity,
  createDatabaseConnection,
  normalizeDatabaseUrl,
  normalizeNeonEndpoint,
  readDatabaseIdentity,
  resolveDatabaseConfig,
  runDatabaseMigrations,
  verifyDatabaseConnection,
} from "./connection";
