import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { readRuntimeConfig } from "./runtimeConfig";

async function start() {
  const config = readRuntimeConfig(process.env);
  const connection = createDatabaseConnection({ target: config.target });
  try {
    await verifyDatabaseConnection(connection);
    const auth = createAuth({ db: connection.db, ...config });
    const app = createApp({
      auth,
      db: connection.db,
      adminOrigin: config.adminOrigin,
      guestFingerprintSecret: config.fingerprintSecret,
      guestTrustProxyHeaders: config.trustProxyHeaders,
      authForDatabase: (db) => createAuth({ db, ...config }),
    });
    const server = serve({ fetch: app.fetch, port: config.port });
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      server.close(() => {
        void connection.close();
      });
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  } catch (error) {
    await connection.close();
    throw error;
  }
}

start().catch(() => {
  console.error(
    "API startup failed; verify runtime configuration and database identity",
  );
  process.exitCode = 1;
});
