import type { DatabaseConnection } from "@entrelacos/database";
import { createAuth } from "./auth";
import type { AuthInstance } from "./authHttp";
import type { GiftMediaComposition } from "./giftMediaComposition";
import { createGiftPaymentComposition } from "./giftPaymentComposition";
import { createGiftPaymentHistoryApplication } from "./giftPaymentHistoryComposition";
import {
  createReceivingSetupComposition,
  type ReceivingSetupComposition,
} from "./receivingSetupComposition";
import type { readRuntimeConfig } from "./runtimeConfig";

export async function createGiftApplication(
  config: ReturnType<typeof readRuntimeConfig>,
  connection: Pick<DatabaseConnection, "db">,
  auth: AuthInstance,
  media: GiftMediaComposition["ports"],
) {
  const now = () => new Date();
  const authentication = {
    db: connection.db,
    secret: config.secret,
    baseURL: config.baseURL,
    adminOrigin: config.adminOrigin,
  };
  let receiving: ReceivingSetupComposition | undefined;
  const payments = createGiftPaymentComposition(config.giftPayment, {
    db: connection.db,
    publicOrigin: config.giftPublicOrigin ?? "http://localhost:4321",
    now,
    refreshReceiving: async (siteId) => {
      await receiving?.refreshReceiving?.(siteId);
    },
  });
  let application:
    | Awaited<ReturnType<typeof createGiftPaymentHistoryApplication>>
    | undefined;
  try {
    receiving = createReceivingSetupComposition(config.giftPayment, {
      ...authentication,
      standardAuth: auth,
      now,
    });
    application = await createGiftPaymentHistoryApplication(
      config.giftPaymentHistory,
      {
        ...authentication,
        standardAuth: auth,
        mediaAuth: media.giftMediaAuth,
        now,
      },
      {
        auth,
        db: connection.db,
        adminOrigin: config.adminOrigin,
        guestFingerprintSecret: config.fingerprintSecret,
        guestTrustProxyHeaders: config.trustProxyHeaders,
        authForDatabase: (db) => createAuth({ db, ...config }),
        ...media,
        ...payments.ports,
        ...receiving.ports,
      },
    );
    const closeHistory = application.close.bind(application);
    const closeReceiving = receiving.close.bind(receiving);
    let closing: Promise<void> | undefined;
    const close = () => {
      closing ??= Promise.all([
        payments.close(),
        closeReceiving(),
        closeHistory(),
      ]).then(() => {});
      return closing;
    };
    payments.start();
    return Object.assign(application, { close });
  } catch {
    await Promise.allSettled([
      payments.close(),
      receiving?.close(),
      application?.close(),
    ]);
    throw new Error("Gift application unavailable");
  }
}
