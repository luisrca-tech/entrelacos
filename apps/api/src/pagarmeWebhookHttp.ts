import {
  internalGiftsEndpointPaths,
  pagarmeWebhookAcceptanceSchema,
} from "@entrelacos/contracts";
import { type Context, Hono } from "hono";
import { PagarmeWebhookError } from "./pagarmeWebhook";

export interface PagarmeWebhookHttpReceiver {
  receive(
    authorization: string | undefined,
    rawBody: unknown,
  ): Promise<{ accepted: true }>;
}

function problem(context: Context, status: 400 | 401 | 503, code: string) {
  return context.newResponse(
    JSON.stringify({
      type: "about:blank",
      title: status === 503 ? "Webhook unavailable" : "Webhook rejected",
      status,
      code,
    }),
    status,
    {
      "Content-Type": "application/problem+json",
      "Cache-Control": "no-store",
      ...(status === 401
        ? { "WWW-Authenticate": 'Basic realm="pagarme-webhook"' }
        : {}),
    },
  );
}

async function readRawBody(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

/** POST /v1/webhooks/pagarme, authenticated by the receiver (Basic auth). */
export function createPagarmeWebhookHttpRouter(
  receiver?: PagarmeWebhookHttpReceiver,
): Hono {
  const router = new Hono();
  router.onError((error, context) =>
    error instanceof PagarmeWebhookError
      ? problem(context, error.status, error.code)
      : problem(context, 503, "WEBHOOK_UNAVAILABLE"),
  );
  const [method, path] = internalGiftsEndpointPaths.pagarmeWebhook.split(" ");
  router.on(method, path, async (context) => {
    context.header("Cache-Control", "no-store");
    if (new URL(context.req.url).search)
      return problem(context, 400, "WEBHOOK_INVALID");
    if (!receiver) return problem(context, 503, "WEBHOOK_UNAVAILABLE");
    if (
      context.req.header("Content-Type")?.split(";")[0].trim().toLowerCase() !==
      "application/json"
    )
      return problem(context, 400, "WEBHOOK_INVALID");
    const body = await readRawBody(context.req.raw);
    if (body === null) return problem(context, 400, "WEBHOOK_INVALID");
    const accepted = pagarmeWebhookAcceptanceSchema.safeParse(
      await receiver.receive(context.req.header("Authorization"), body),
    );
    if (!accepted.success) return problem(context, 503, "WEBHOOK_UNAVAILABLE");
    return context.json(accepted.data);
  });
  return router;
}
