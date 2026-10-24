import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { createAuth, createSessionReadAuth } from "./auth";
import { createGiftApplication } from "./giftApplication";
import {
  createGiftMediaComposition,
  startGiftMediaRuntime,
} from "./giftMediaComposition";
import { readRuntimeConfig } from "./runtimeConfig";

async function start() {
  const config = readRuntimeConfig(process.env);
  const connection = createDatabaseConnection({ target: config.target });
  const runtime = startGiftMediaRuntime({
    initialize: async () => {
      await verifyDatabaseConnection(connection);
      return createAuth({ db: connection.db, ...config });
    },
    createMedia: () =>
      createGiftMediaComposition(config.giftMedia, {
        createReadAuth: () =>
          createSessionReadAuth({ db: connection.db, ...config }),
      }),
    createApplication: (media, auth) =>
      createGiftApplication(config, connection, auth, media),
    port: config.port,
    closeDatabase: () => connection.close(),
    onError: () => {
      console.error("API shutdown failed");
      process.exitCode = 1;
    },
  });
  await runtime.ready;
}

start().catch(() => {
  console.error(
    "API startup failed; verify runtime configuration and database identity",
  );
  process.exitCode = 1;
});
