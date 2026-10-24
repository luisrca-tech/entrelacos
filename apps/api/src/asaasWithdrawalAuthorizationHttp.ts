import { type Context, Hono } from "hono";

export interface AsaasWithdrawalAuthorizationHttpReceiver {
  receive(
    token: string,
    rawBody: string,
  ): Promise<{ status: "APPROVED" | "REFUSED" }>;
}

function refuse(context: Context, status: 400 | 401 | 503) {
  context.header("Cache-Control", "no-store");
  return context.json({ status: "REFUSED" }, status);
}

async function readBody(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, 2000);
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
    return expired
      ? null
      : new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

export function createAsaasWithdrawalAuthorizationHttpRouter(
  receiver?: AsaasWithdrawalAuthorizationHttpReceiver,
): Hono {
  const router = new Hono();
  router.onError((_error, context) => refuse(context, 503));
  router.post(
    "/v1/webhooks/asaas/withdrawal-authorization",
    async (context) => {
      context.header("Cache-Control", "no-store");
      if (new URL(context.req.url).search) return refuse(context, 400);
      const token = context.req.header("asaas-access-token");
      if (typeof token !== "string" || !/^[\x21-\x7e]{32,255}$/.test(token))
        return refuse(context, 401);
      if (
        context.req
          .header("Content-Type")
          ?.split(";")[0]
          .trim()
          .toLowerCase() !== "application/json"
      )
        return refuse(context, 400);
      if (!receiver) return refuse(context, 503);
      const body = await readBody(context.req.raw);
      if (body === null) return refuse(context, 400);
      const decision = await receiver.receive(token, body);
      if (
        !decision ||
        typeof decision !== "object" ||
        Object.keys(decision).length !== 1 ||
        !["APPROVED", "REFUSED"].includes(decision.status)
      )
        return refuse(context, 503);
      return context.json({ status: decision.status });
    },
  );
  return router;
}
