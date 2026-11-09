import { describe, expect, it, vi } from "vitest";
import {
  assertDatabaseIdentity,
  createDatabaseConnection,
  normalizeDatabaseUrl,
  normalizeNeonEndpoint,
  readDatabaseIdentity,
  resolveDatabaseConfig,
  resolveMigrationConnectionUrl,
} from "./connection";

const developmentUrl =
  "postgresql://user:development-secret@ep-development-pooler.example.neon.tech/neondb?sslmode=require";
const testUrl =
  "postgresql://user:test-secret@ep-testing-pooler.example.neon.tech/neondb?sslmode=require";
const productionUrl =
  "postgresql://user:production-secret@ep-production-pooler.example.neon.tech/neondb?sslmode=require";
const migrationUrl =
  "postgresql://migration-role:migration-secret@ep-development.example.neon.tech/neondb?sslmode=require";
const localDevelopmentUrl =
  "postgresql://entrelacos:local@127.0.0.1:55432/entrelacos_dev";
const localTestUrl =
  "postgresql://entrelacos:local@127.0.0.1:55432/entrelacos_test";

const expectedEnvironment = {
  DATABASE_URL: developmentUrl,
  DATABASE_URL_TEST: testUrl,
  DATABASE_URL_PRODUCTION: productionUrl,
  DATABASE_TEST_BRANCH_ID: "br-testing",
  DATABASE_DEVELOPMENT_BRANCH_ID: "br-development",
  DATABASE_PROJECT_ID: "project-id",
  DATABASE_NAME: "neondb",
};

describe("database connection guards", () => {
  it("supports separate local development and test databases on the same server", () => {
    const env = {
      DATABASE_URL: localDevelopmentUrl,
      DATABASE_URL_TEST: localTestUrl,
    };
    for (const [target, url, databaseName] of [
      ["development", localDevelopmentUrl, "entrelacos_dev"],
      ["test", localTestUrl, "entrelacos_test"],
    ] as const) {
      const config = resolveDatabaseConfig(target, env);
      expect(config.url).toBe(`${url}?sslmode=disable`);
      expect(config.expectedIdentity).toEqual({
        databaseName,
        userName: "entrelacos",
      });
    }
  });

  it("rejects using the local development database for integration tests", () => {
    expect(() =>
      resolveDatabaseConfig("test", {
        DATABASE_URL: localDevelopmentUrl,
        DATABASE_URL_TEST: localDevelopmentUrl.replace(
          "127.0.0.1",
          "localhost",
        ),
      }),
    ).toThrow(/disposable.*test database/i);
  });

  it("requires a remote development reference before accepting a remote test URL", () => {
    expect(() =>
      resolveDatabaseConfig("test", {
        DATABASE_URL: localDevelopmentUrl,
        DATABASE_URL_TEST: testUrl,
      }),
    ).toThrow(/remote development database/i);
  });

  it("rejects connection parameters that can override the checked host", () => {
    expect(() =>
      resolveDatabaseConfig("development", {
        DATABASE_URL: `${localDevelopmentUrl}?host=remote.example`,
      }),
    ).toThrow("Invalid database connection URL");
  });

  it("does not expose a malformed private URL in configuration errors", () => {
    try {
      resolveDatabaseConfig("test", {
        ...expectedEnvironment,
        DATABASE_URL_TEST: "invalid-private-password",
      });
      throw new Error("Expected configuration rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(JSON.stringify(error)).not.toContain("invalid-private-password");
      expect((error as Error).message).toBe("Invalid database connection URL");
    }
  });
  it("rejects two distinct computes configured for the same branch", () => {
    expect(() =>
      resolveDatabaseConfig("test", {
        ...expectedEnvironment,
        DATABASE_TEST_BRANCH_ID:
          expectedEnvironment.DATABASE_DEVELOPMENT_BRANCH_ID,
      }),
    ).toThrow(/distinct.*branch/i);
  });

  it("rejects unsupported runtime targets", () => {
    expect(() =>
      resolveDatabaseConfig("main" as "test", expectedEnvironment),
    ).toThrow(/target/i);
  });
  it("normalizes Neon pooler endpoints and enforces full TLS", () => {
    expect(normalizeNeonEndpoint(testUrl)).toBe("ep-testing.example.neon.tech");
    expect(
      new URL(normalizeDatabaseUrl(developmentUrl)).searchParams.get("sslmode"),
    ).toBe("verify-full");
  });

  it("requires DATABASE_URL_TEST for test connections", () => {
    expect(() =>
      resolveDatabaseConfig("test", {
        ...expectedEnvironment,
        DATABASE_URL_TEST: "",
      }),
    ).toThrow("DATABASE_URL_TEST");
  });

  it("derives production identity checks from DATABASE_URL only", () => {
    expect(
      resolveDatabaseConfig("production", {
        DATABASE_URL: productionUrl,
      }),
    ).toMatchObject({
      target: "production",
      endpoint: "ep-production.example.neon.tech",
      expectedIdentity: {
        endpointId: "ep-production",
        databaseName: "neondb",
        userName: "user",
      },
    });
  });

  it("derives development identity checks from DATABASE_URL only", () => {
    expect(
      resolveDatabaseConfig("development", {
        DATABASE_URL: developmentUrl,
      }),
    ).toMatchObject({
      target: "development",
      endpoint: "ep-development.example.neon.tech",
      expectedIdentity: {
        endpointId: "ep-development",
        databaseName: "neondb",
        userName: "user",
      },
    });
  });

  it("derives test identity from its URL when Neon metadata is absent", () => {
    expect(
      resolveDatabaseConfig("test", {
        DATABASE_URL: developmentUrl,
        DATABASE_URL_TEST: testUrl,
      }),
    ).toMatchObject({
      target: "test",
      endpoint: "ep-testing.example.neon.tech",
      expectedIdentity: {
        endpointId: "ep-testing",
        databaseName: "neondb",
        userName: "user",
      },
    });
  });

  it("rejects a test URL that points to development or production", () => {
    expect(() =>
      resolveDatabaseConfig("test", {
        ...expectedEnvironment,
        DATABASE_URL_TEST: developmentUrl,
      }),
    ).toThrow(/development/i);

    expect(() =>
      resolveDatabaseConfig("test", {
        ...expectedEnvironment,
        DATABASE_URL_TEST: productionUrl,
      }),
    ).toThrow(/production/i);
  });

  it("checks Neon identity and local database identity", () => {
    expect(() =>
      assertDatabaseIdentity(
        "test",
        {
          branchId: "br-testing",
          projectId: "project-id",
          endpointId: "ep-testing",
          databaseName: "neondb",
          userName: "neondb_owner",
        },
        {
          branchId: "br-testing",
          projectId: "project-id",
          databaseName: "neondb",
        },
      ),
    ).not.toThrow();

    expect(() =>
      assertDatabaseIdentity(
        "test",
        {
          branchId: "br-development",
          projectId: "project-id",
          endpointId: "ep-testing",
          databaseName: "neondb",
          userName: "neondb_owner",
        },
        {
          branchId: "br-testing",
          projectId: "project-id",
          databaseName: "neondb",
        },
      ),
    ).toThrow(/branch/i);

    expect(() =>
      assertDatabaseIdentity(
        "production",
        {
          branchId: null,
          projectId: null,
          endpointId: "ep-production",
          databaseName: "neondb",
          userName: "user",
        },
        {
          endpointId: "ep-production",
          databaseName: "neondb",
          userName: "user",
        },
      ),
    ).not.toThrow();
  });

  it("reads all required identity values with one query", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          branch_id: "br-testing",
          project_id: "project-id",
          endpoint_id: "ep-testing",
          database_name: "neondb",
          user_name: "neondb_owner",
        },
      ],
    });

    const identity = await readDatabaseIdentity({ query } as never);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain(
      "current_setting('neon.branch_id', true)",
    );
    expect(query.mock.calls[0][0]).toContain(
      "current_setting('neon.project_id', true)",
    );
    expect(query.mock.calls[0][0]).toContain(
      "current_setting('neon.endpoint_id', true)",
    );
    expect(identity).toEqual({
      branchId: "br-testing",
      projectId: "project-id",
      endpointId: "ep-testing",
      databaseName: "neondb",
      userName: "neondb_owner",
    });
  });

  it("closes an injected pool exactly once", async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const connection = createDatabaseConnection({
      target: "test",
      env: expectedEnvironment,
      poolFactory: () => ({ end }) as never,
    });

    await connection.close();
    await connection.close();

    expect(end).toHaveBeenCalledOnce();
  });
});

describe("migration connection url", () => {
  it("allows local migrations and checks the local port", () => {
    expect(
      resolveMigrationConnectionUrl({
        DATABASE_URL: localDevelopmentUrl,
        DATABASE_DIRECT_URL: localDevelopmentUrl,
      }),
    ).toBe(`${localDevelopmentUrl}?sslmode=disable`);
    expect(() =>
      resolveMigrationConnectionUrl({
        DATABASE_URL: localDevelopmentUrl,
        DATABASE_DIRECT_URL: localDevelopmentUrl.replace("55432", "5432"),
      }),
    ).toThrow(/match the development endpoint/);
  });

  it.each(["ep-production.example.neon.tech", " "])(
    "rejects deployment credentials with an incorrect or blank configured endpoint (%s)",
    (expectedHost) => {
      expect(() =>
        resolveMigrationConnectionUrl({
          DATABASE_URL: developmentUrl,
          DATABASE_DIRECT_URL: migrationUrl,
          DATABASE_MIGRATION_HOST: expectedHost,
        }),
      ).toThrow(/configured deployment endpoint/);
    },
  );

  it("uses the direct URL and permits a different role on the same destination", () => {
    expect(
      resolveMigrationConnectionUrl({
        DATABASE_URL: developmentUrl,
        DATABASE_DIRECT_URL: migrationUrl,
      }),
    ).toBe(normalizeDatabaseUrl(migrationUrl));
  });

  it("supports direct-only migration configuration and ignores TEST identity", () => {
    expect(
      resolveMigrationConnectionUrl({
        DATABASE_DIRECT_URL: migrationUrl,
        DATABASE_URL_TEST: testUrl,
      }),
    ).toBe(normalizeDatabaseUrl(migrationUrl));
  });

  it.each([undefined, "", "   "])(
    "requires a nonempty DIRECT URL without falling back to runtime (%s)",
    (directUrl) => {
      expect(() =>
        resolveMigrationConnectionUrl({
          DATABASE_URL: developmentUrl,
          DATABASE_DIRECT_URL: directUrl,
        }),
      ).toThrow(
        "Missing required database environment variable: DATABASE_DIRECT_URL",
      );
    },
  );

  it("requires DIRECT even when no runtime URL exists", () => {
    expect(() => resolveMigrationConnectionUrl({})).toThrow(
      "DATABASE_DIRECT_URL",
    );
  });

  it.each([
    developmentUrl,
    developmentUrl.replace("ep-development-pooler", "EP-DEVELOPMENT-POOLER"),
  ])("rejects pooled Neon migration connections (%s)", (directUrl) => {
    expect(() =>
      resolveMigrationConnectionUrl({ DATABASE_DIRECT_URL: directUrl }),
    ).toThrow("Migration connection must use a direct Neon endpoint");
  });

  it.each([
    [migrationUrl.replace("ep-development", "ep-other"), "endpoint"],
    [migrationUrl.replace("/neondb", "/otherdb"), "database"],
  ])("rejects a different development destination (%s)", (directUrl, part) => {
    expect(() =>
      resolveMigrationConnectionUrl({
        DATABASE_URL: developmentUrl,
        DATABASE_DIRECT_URL: directUrl,
      }),
    ).toThrow(`Migration connection must match the development ${part}`);
  });

  it("compares decoded database names and normalized Neon endpoints", () => {
    const directUrl = migrationUrl
      .replace("ep-development", "EP-DEVELOPMENT")
      .replace("/neondb", "/neon%64b");
    expect(
      resolveMigrationConnectionUrl({
        DATABASE_URL: developmentUrl,
        DATABASE_DIRECT_URL: ` ${directUrl} `,
      }),
    ).toBe(normalizeDatabaseUrl(directUrl));
  });

  it("rejects the divergent last-loaded DIRECT assignment", () => {
    const env = {
      DATABASE_URL: developmentUrl,
      DATABASE_DIRECT_URL: migrationUrl,
    };
    Object.assign(env, {
      DATABASE_DIRECT_URL: migrationUrl.replace("ep-development", "ep-other"),
    });
    expect(() => resolveMigrationConnectionUrl(env)).toThrow(
      "Migration connection must match the development endpoint",
    );
  });

  it.each([
    "invalid-private-password",
    "https://user:private-password@ep-development.example.neon.tech/neondb",
    "postgresql:///neondb",
    "postgresql://user:private-password@ep-development.example.neon.tech/",
    "postgresql://user:private-password@ep-development.example.neon.tech/%FF",
  ])("sanitizes malformed DIRECT configuration (%s)", (directUrl) => {
    let caught: unknown;
    try {
      resolveMigrationConnectionUrl({ DATABASE_DIRECT_URL: directUrl });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Invalid database connection URL");
    expect(String(caught)).not.toContain("private-password");
    expect(JSON.stringify(caught)).not.toContain(directUrl);
  });

  it.each([
    "invalid-runtime-private-password",
    "postgresql://user:runtime-private-password@ep-development.example.neon.tech/%FF",
  ])("sanitizes malformed runtime comparison (%s)", (runtimeUrl) => {
    expect(() =>
      resolveMigrationConnectionUrl({
        DATABASE_URL: runtimeUrl,
        DATABASE_DIRECT_URL: migrationUrl,
      }),
    ).toThrow("Invalid database connection URL");
  });

  it("keeps runtime and TEST selection independent of DIRECT", () => {
    const env = {
      ...expectedEnvironment,
      DATABASE_DIRECT_URL: "invalid-unused-direct-private-password",
    };
    expect(resolveDatabaseConfig("development", env).url).toBe(
      normalizeDatabaseUrl(developmentUrl),
    );
    expect(resolveDatabaseConfig("production", env).url).toBe(
      normalizeDatabaseUrl(developmentUrl),
    );
    expect(resolveDatabaseConfig("test", env).url).toBe(
      normalizeDatabaseUrl(testUrl),
    );
  });
});
