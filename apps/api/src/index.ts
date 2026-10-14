import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { createAuth, createSessionReadAuth } from "./auth";
import {
  createGiftMediaComposition,
  startGiftMediaRuntime,
} from "./giftMediaComposition";
import { createGiftPaymentHistoryApplication } from "./giftPaymentHistoryComposition";
import { readRuntimeConfig } from "./runtimeConfig";

async function start() {
  const config = readRuntimeConfig(process.env);
  const connection = createDatabaseConnection({ target: config.target });
  const historyClock = () => new Date();
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
      createGiftPaymentHistoryApplication(
        config.giftPaymentHistory,
        {
          db: connection.db,
          secret: config.secret,
          baseURL: config.baseURL,
          adminOrigin: config.adminOrigin,
          standardAuth: auth,
          mediaAuth: media.giftMediaAuth,
          now: historyClock,
        },
        {
          auth,
          db: connection.db,
          adminOrigin: config.adminOrigin,
          guestFingerprintSecret: config.fingerprintSecret,
          guestTrustProxyHeaders: config.trustProxyHeaders,
          authForDatabase: (db) => createAuth({ db, ...config }),
          ...media,
        },
      ),
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
