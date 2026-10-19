import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "./connection";

let connection: DatabaseConnection;
beforeAll(async () => {
  connection = createDatabaseConnection({ target: "test" });
  await verifyDatabaseConnection(connection);
});
afterAll(async () => {
  await connection?.close();
});

describe("PostgreSQL immutable withdrawal provider custody", () => {
  it("rejects UPDATE and DELETE using the migrated trigger function", async () => {
    const client = await connection.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "CREATE TEMP TABLE custody_immutability_probe (id text PRIMARY KEY) ON COMMIT DROP",
      );
      await client.query(
        "CREATE TRIGGER custody_probe_immutable BEFORE UPDATE OR DELETE ON custody_immutability_probe FOR EACH ROW EXECUTE FUNCTION reject_withdrawal_provider_observation_mutation()",
      );
      await client.query(
        "INSERT INTO custody_immutability_probe VALUES ('retained')",
      );
      for (const statement of [
        "UPDATE custody_immutability_probe SET id='changed'",
        "DELETE FROM custody_immutability_probe",
      ]) {
        await client.query("SAVEPOINT mutation_probe");
        await expect(client.query(statement)).rejects.toThrow(
          "Withdrawal provider observations are immutable",
        );
        await client.query("ROLLBACK TO SAVEPOINT mutation_probe");
      }
      expect(
        (await client.query("SELECT id FROM custody_immutability_probe")).rows,
      ).toEqual([{ id: "retained" }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
