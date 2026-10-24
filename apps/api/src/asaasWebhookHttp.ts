import {
  asaasWebhookAcceptanceSchema,
  internalGiftsEndpointPaths,
} from "@entrelacos/contracts";
import { type Context, Hono } from "hono";
import { AsaasWebhookError } from "./asaasWebhook";

export interface AsaasWebhookHttpReceiver {
  receive(token: unknown, rawBody: unknown): Promise<{ accepted: true }>;
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
    { "Content-Type": "application/problem+json", "Cache-Control": "no-store" },
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
export function createAsaasWebhookHttpRouter(
  receiver?: AsaasWebhookHttpReceiver,
): Hono {
  const router = new Hono();
  router.onError((error, context) =>
    error instanceof AsaasWebhookError
      ? problem(context, error.status, error.code)
      : problem(context, 503, "WEBHOOK_UNAVAILABLE"),
  );
  const [method, path] = internalGiftsEndpointPaths.asaasWebhook.split(" ");
  router.on(method, path, async (context) => {
    context.header("Cache-Control", "no-store");
    if (new URL(context.req.url).search)
      return problem(context, 400, "WEBHOOK_INVALID");
    const token = context.req.header("asaas-access-token");
    if (
      typeof token !== "string" ||
      token.length < 32 ||
      token.length > 255 ||
      !/^[\x21-\x7e]+$/.test(token)
    )
      return problem(context, 401, "WEBHOOK_AUTH_DENIED");
    if (
      context.req.header("Content-Type")?.split(";")[0].trim().toLowerCase() !==
      "application/json"
    )
      return problem(context, 400, "WEBHOOK_INVALID");
    if (!receiver) return problem(context, 503, "WEBHOOK_UNAVAILABLE");
    const body = await readRawBody(context.req.raw);
    if (body === null) return problem(context, 400, "WEBHOOK_INVALID");
    const accepted = asaasWebhookAcceptanceSchema.safeParse(
      await receiver.receive(token, body),
    );
    if (!accepted.success) return problem(context, 503, "WEBHOOK_UNAVAILABLE");
    return context.json(accepted.data);
  });
  return router;
}
