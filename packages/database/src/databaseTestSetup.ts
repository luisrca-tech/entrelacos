import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "./connection";

export default async function setup() {
  const connection = createDatabaseConnection({ target: "test" });
  try {
    await verifyDatabaseConnection(connection);
  } catch {
    throw new Error(
      "Integration database identity verification failed; tests were not started.",
    );
  } finally {
    await connection.close();
  }
}
