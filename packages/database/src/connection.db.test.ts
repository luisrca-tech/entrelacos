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

  it("verifies the disposable test database without running migrations", async () => {
    connection = createDatabaseConnection({ target: "test" });
    const identity = await verifyDatabaseConnection(connection);

    expect(identity.databaseName).toBe(process.env.DATABASE_NAME);
    expect(identity.branchId).toBe(process.env.DATABASE_TEST_BRANCH_ID);
  }, 30_000);
});
