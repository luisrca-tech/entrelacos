import { afterEach, describe, expect, it } from "vitest";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "./connection";

describe("database identity integration", () => {
  let connection: DatabaseConnection | undefined;

  afterEach(async () => {
    await connection?.close();
    connection = undefined;
  });

  it("verifies the disposable test database without optional identity metadata", async () => {
    connection = createDatabaseConnection({
      target: "test",
      env: {
        DATABASE_URL: process.env.DATABASE_URL,
        DATABASE_URL_TEST: process.env.DATABASE_URL_TEST,
        DATABASE_URL_PRODUCTION: process.env.DATABASE_URL_PRODUCTION,
      },
    });
    const url = new URL(connection.config.url);
    const identity = await verifyDatabaseConnection(connection);

    expect(identity.databaseName).toBe(
      decodeURIComponent(url.pathname.slice(1)),
    );
    expect(identity.userName).toBe(decodeURIComponent(url.username));
  }, 30_000);
});
