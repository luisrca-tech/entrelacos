import { describe, expect, it, vi } from "vitest";
import {
  assertDatabaseIdentity,
  createDatabaseConnection,
  normalizeDatabaseUrl,
  normalizeNeonEndpoint,
  readDatabaseIdentity,
  resolveDatabaseConfig,
} from "./connection";

const developmentUrl =
  "postgresql://user:development-secret@ep-development-pooler.example.neon.tech/neondb?sslmode=require";
const testUrl =
  "postgresql://user:test-secret@ep-testing-pooler.example.neon.tech/neondb?sslmode=require";
const productionUrl =
  "postgresql://user:production-secret@ep-production-pooler.example.neon.tech/neondb?sslmode=require";

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
