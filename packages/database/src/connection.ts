import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolConfig } from "pg";

export type DatabaseTarget = "development" | "test" | "production";

export interface DatabaseIdentity {
  branchId: string | null;
  projectId: string | null;
  endpointId: string | null;
  databaseName: string;
  userName: string;
}

export interface ExpectedDatabaseIdentity {
  branchId?: string;
  projectId?: string;
  endpointId?: string;
  databaseName: string;
  userName?: string;
}

export interface DatabaseConfig {
  target: DatabaseTarget;
  url: string;
  endpoint: string;
  expectedIdentity: ExpectedDatabaseIdentity;
}

export interface DatabaseEnvironment extends NodeJS.ProcessEnv {
  DATABASE_URL?: string;
  DATABASE_URL_TEST?: string;
  DATABASE_URL_PRODUCTION?: string;
  DATABASE_TEST_BRANCH_ID?: string;
  DATABASE_DEVELOPMENT_BRANCH_ID?: string;
  DATABASE_PROJECT_ID?: string;
  DATABASE_NAME?: string;
  DATABASE_USER?: string;
  DATABASE_ROLE?: string;
}

export interface DatabaseConnectionOptions {
  target: DatabaseTarget;
  env?: DatabaseEnvironment;
  poolConfig?: Omit<PoolConfig, "connectionString">;
  poolFactory?: (config: PoolConfig) => Pool;
}

export interface DatabaseConnection {
  config: DatabaseConfig;
  pool: Pool;
  db: NodePgDatabase<Record<string, never>>;
  close: () => Promise<void>;
}

const identityQuery = `
  SELECT
    current_setting('neon.branch_id', true) AS branch_id,
    current_setting('neon.project_id', true) AS project_id,
    current_setting('neon.endpoint_id', true) AS endpoint_id,
    current_database() AS database_name,
    current_user AS user_name
`;

function requiredEnvironmentValue(
  env: DatabaseEnvironment,
  name: keyof DatabaseEnvironment,
): string {
  const value = env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required database environment variable: ${name}`);
  }
  return value.trim();
}

function parseDatabaseUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error();
    return url;
  } catch {
    throw new Error("Invalid database connection URL");
  }
}

function endpointIdFromUrl(value: string): string {
  const firstLabel = parseDatabaseUrl(value).hostname.split(".")[0];
  return firstLabel.replace(/-pooler$/i, "");
}

function userNameFromUrl(value: string): string | undefined {
  const userName = parseDatabaseUrl(value).username;
  return userName ? decodeURIComponent(userName) : undefined;
}

function databaseNameFromUrl(value: string): string {
  const databaseName = decodeURIComponent(
    parseDatabaseUrl(value).pathname.slice(1),
  );
  if (!databaseName)
    throw new Error("Database connection URL must name a database");
  return databaseName;
}

export function normalizeDatabaseUrl(value: string): string {
  const url = parseDatabaseUrl(value);
  url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

export function normalizeNeonEndpoint(value: string): string {
  const url = parseDatabaseUrl(value);
  const labels = url.hostname.toLowerCase().split(".");
  labels[0] = labels[0].replace(/-pooler$/i, "");
  return labels.join(".");
}

export function resolveDatabaseConfig(
  target: DatabaseTarget,
  env: DatabaseEnvironment = process.env,
): DatabaseConfig {
  if (
    target !== "development" &&
    target !== "test" &&
    target !== "production"
  ) {
    throw new Error("Unsupported database target");
  }
  const urlVariable = target === "test" ? "DATABASE_URL_TEST" : "DATABASE_URL";
  const rawUrl = requiredEnvironmentValue(env, urlVariable);
  const endpoint = normalizeNeonEndpoint(rawUrl);

  if (target === "test") {
    const developmentUrl = requiredEnvironmentValue(env, "DATABASE_URL");
    const developmentEndpoint = normalizeNeonEndpoint(developmentUrl);
    if (endpoint === developmentEndpoint) {
      throw new Error(
        "Test database endpoint must be distinct from development",
      );
    }

    const productionUrl = env.DATABASE_URL_PRODUCTION?.trim();
    if (productionUrl && endpoint === normalizeNeonEndpoint(productionUrl)) {
      throw new Error(
        "Test database endpoint must be distinct from production",
      );
    }
  }

  if (target === "production") {
    return {
      target,
      url: normalizeDatabaseUrl(rawUrl),
      endpoint,
      expectedIdentity: {
        endpointId: endpointIdFromUrl(rawUrl),
        databaseName: databaseNameFromUrl(rawUrl),
        userName: userNameFromUrl(rawUrl),
      },
    };
  }

  const branchVariable =
    target === "test"
      ? "DATABASE_TEST_BRANCH_ID"
      : "DATABASE_DEVELOPMENT_BRANCH_ID";
  const branchId = requiredEnvironmentValue(env, branchVariable);
  if (
    target === "test" &&
    branchId === requiredEnvironmentValue(env, "DATABASE_DEVELOPMENT_BRANCH_ID")
  ) {
    throw new Error("Test and development require distinct Neon branches");
  }

  return {
    target,
    url: normalizeDatabaseUrl(rawUrl),
    endpoint,
    expectedIdentity: {
      branchId,
      projectId: requiredEnvironmentValue(env, "DATABASE_PROJECT_ID"),
      endpointId: endpointIdFromUrl(rawUrl),
      databaseName: requiredEnvironmentValue(env, "DATABASE_NAME"),
      userName:
        (env.DATABASE_USER ?? env.DATABASE_ROLE)?.trim() ||
        userNameFromUrl(rawUrl),
    },
  };
}

export function assertDatabaseIdentity(
  target: DatabaseTarget,
  actual: DatabaseIdentity,
  expected: ExpectedDatabaseIdentity,
): void {
  if (
    expected.branchId &&
    (!actual.branchId || actual.branchId !== expected.branchId)
  ) {
    throw new Error(`Database ${target} identity mismatch: Neon branch`);
  }
  if (
    expected.projectId &&
    (!actual.projectId || actual.projectId !== expected.projectId)
  ) {
    throw new Error(`Database ${target} identity mismatch: Neon project`);
  }
  if (
    expected.endpointId &&
    (!actual.endpointId || actual.endpointId !== expected.endpointId)
  ) {
    throw new Error(`Database ${target} identity mismatch: Neon endpoint`);
  }
  if (actual.databaseName !== expected.databaseName) {
    throw new Error(`Database ${target} identity mismatch: database name`);
  }
  if (
    !actual.userName ||
    (expected.userName && actual.userName !== expected.userName)
  ) {
    throw new Error(`Database ${target} identity mismatch: database user`);
  }
}

export async function readDatabaseIdentity(
  pool: Pick<Pool, "query">,
): Promise<DatabaseIdentity> {
  const result = await pool.query(identityQuery);
  const row = result.rows[0] as
    | {
        branch_id: string | null;
        project_id: string | null;
        endpoint_id: string | null;
        database_name: string;
        user_name: string;
      }
    | undefined;

  if (!row) {
    throw new Error("Database identity query returned no row");
  }

  return {
    branchId: row.branch_id,
    projectId: row.project_id,
    endpointId: row.endpoint_id,
    databaseName: row.database_name,
    userName: row.user_name,
  };
}

export function createDatabaseConnection(
  options: DatabaseConnectionOptions,
): DatabaseConnection {
  const config = resolveDatabaseConfig(options.target, options.env);
  const poolOptions: PoolConfig = {
    ...options.poolConfig,
    connectionString: config.url,
  };
  const pool = options.poolFactory
    ? options.poolFactory(poolOptions)
    : new Pool(poolOptions);
  // Keep SQL and bound parameters out of logs.
  const db = drizzle(pool, { logger: false });
  let closed = false;

  return {
    config,
    pool,
    db,
    close: async () => {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}

export async function verifyDatabaseConnection(
  connection: DatabaseConnection,
): Promise<DatabaseIdentity> {
  const identity = await readDatabaseIdentity(connection.pool);
  assertDatabaseIdentity(
    connection.config.target,
    identity,
    connection.config.expectedIdentity,
  );
  return identity;
}

export function resolveMigrationConnectionUrl(
  env: DatabaseEnvironment = process.env,
): string {
  return normalizeDatabaseUrl(requiredEnvironmentValue(env, "DATABASE_URL"));
}

export async function runDatabaseMigrations(options: {
  migrationsFolder: string;
  env?: DatabaseEnvironment;
}): Promise<void> {
  const pool = new Pool({
    connectionString: resolveMigrationConnectionUrl(options.env),
  });
  const db = drizzle(pool, { logger: false });
  try {
    await migrate(db, {
      migrationsFolder: options.migrationsFolder,
    });
  } finally {
    await pool.end();
  }
}
