import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  brazilianPhoneE164Schema,
  demoGuestGrantIssueInputSchema,
  demoGuestGrantResponseSchema,
} from "@entrelacos/contracts";
import { guestGroup, site } from "@entrelacos/database/schema";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Hono } from "hono";
import type { AdministrativeActor, AuthHttpOptions } from "./authHttp";
import { AdminSessionRequiredError, requireAdminSession } from "./authHttp";

export const DEMO_GUEST_GRANT_HEADER = "X-EntreLacos-Demo-Grant";
export const DEMO_GUEST_GRANT_TTL_MS = 5 * 60 * 1000;

type GrantPayload = {
  version: 1;
  siteId: string;
  phoneFingerprint: string;
  expiresAt: number;
  nonce: string;
};

export class DemoGuestGrantError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(title);
    this.name = "DemoGuestGrantError";
  }
}

function reject(status: number, code: string, title: string): never {
  throw new DemoGuestGrantError(status, code, title);
}

function requireSecret(secret: string): string {
  if (secret.trim().length < 32) {
    reject(
      503,
      "DEMO_GRANT_CONFIGURATION_ERROR",
      "Demo guest grants are not configured",
    );
  }
  return secret;
}

function phoneFingerprint(phoneE164: string, secret: string): string {
  return createHmac("sha256", requireSecret(secret))
    .update(`demo-phone:${phoneE164}`)
    .digest("hex");
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string | undefined {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", requireSecret(secret))
    .update(payload)
    .digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function parsePayload(value: string): GrantPayload | undefined {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object") return undefined;
  const payload = parsed as Record<string, unknown>;
  if (
    payload.version !== 1 ||
    typeof payload.siteId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(payload.siteId) ||
    typeof payload.phoneFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.phoneFingerprint) ||
    typeof payload.expiresAt !== "number" ||
    !Number.isSafeInteger(payload.expiresAt) ||
    typeof payload.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(payload.nonce)
  ) {
    return undefined;
  }
  return payload as unknown as GrantPayload;
}

export function issueDemoGuestGrant(input: {
  siteId: string;
  phoneE164: string;
  secret: string;
  now?: Date;
  ttlMs?: number;
}): string {
  const phoneE164 = brazilianPhoneE164Schema.parse(input.phoneE164);
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? DEMO_GUEST_GRANT_TTL_MS;
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isInteger(ttlMs) ||
    ttlMs < 1
  ) {
    reject(
      400,
      "DEMO_GRANT_CONFIGURATION_ERROR",
      "Invalid demo guest grant lifetime",
    );
  }
  requireSecret(input.secret);
  const payload = encode(
    JSON.stringify({
      version: 1,
      siteId: input.siteId,
      phoneFingerprint: phoneFingerprint(phoneE164, input.secret),
      expiresAt: now.getTime() + ttlMs,
      nonce: randomBytes(18).toString("base64url"),
    } satisfies GrantPayload),
  );
  return `${payload}.${sign(payload, input.secret)}`;
}

export function verifyDemoGuestGrant(
  token: string,
  input: {
    siteId: string;
    phoneE164: string;
    secret: string;
    now?: Date;
  },
): { siteId: string; expiresAt: Date } {
  if (typeof token !== "string" || token.length > 512) {
    reject(403, "INVALID_DEMO_GRANT", "Invalid demo guest grant");
  }
  const separator = token.indexOf(".");
  if (separator <= 0 || separator !== token.lastIndexOf(".")) {
    reject(403, "INVALID_DEMO_GRANT", "Invalid demo guest grant");
  }
  const payloadText = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (
    !/^[A-Za-z0-9_-]+$/.test(payloadText) ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature) ||
    !safeEqual(signature, sign(payloadText, input.secret))
  ) {
    reject(403, "INVALID_DEMO_GRANT", "Invalid demo guest grant");
  }
  const decoded = decode(payloadText);
  if (!decoded) reject(403, "INVALID_DEMO_GRANT", "Invalid demo guest grant");
  let payload: GrantPayload | undefined;
  try {
    payload = parsePayload(decoded);
  } catch {
    payload = undefined;
  }
  if (!payload) reject(403, "INVALID_DEMO_GRANT", "Invalid demo guest grant");
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    reject(400, "DEMO_GRANT_CONFIGURATION_ERROR", "Invalid grant time");
  }
  if (now.getTime() >= payload.expiresAt) {
    reject(410, "DEMO_GRANT_EXPIRED", "Demo guest grant expired");
  }
  const phoneE164 = brazilianPhoneE164Schema.parse(input.phoneE164);
  if (
    payload.siteId !== input.siteId ||
    !safeEqual(
      payload.phoneFingerprint,
      phoneFingerprint(phoneE164, input.secret),
    )
  ) {
    reject(
      403,
      "DEMO_GRANT_MISMATCH",
      "Demo guest grant does not match request",
    );
  }
  return { siteId: payload.siteId, expiresAt: new Date(payload.expiresAt) };
}

export type DemoGuestGrantDatabase = NodePgDatabase<Record<string, never>>;

export async function issueDemoGuestGrantForSite(
  db: DemoGuestGrantDatabase,
  actor: Pick<AdministrativeActor["user"], "id" | "role">,
  siteId: string,
  phoneE164: string,
  options: { secret: string; now?: Date; phoneAllowlist?: readonly string[] },
): Promise<{ grant: string; expiresAt: string }> {
  if (actor.role !== "OWNER") {
    reject(403, "FORBIDDEN", "Only the owner can issue demo grants");
  }
  const phone = brazilianPhoneE164Schema.parse(phoneE164);
  if (!options.phoneAllowlist?.includes(phone)) {
    reject(
      403,
      "DEMO_PHONE_NOT_ALLOWED",
      "Phone is not allowed for demo access",
    );
  }
  const [siteRecord] = await db
    .select({ isDemo: site.isDemo, lifecycle: site.lifecycle })
    .from(site)
    .where(eq(site.id, siteId))
    .limit(1);
  if (!siteRecord) reject(404, "NOT_FOUND", "Not Found");
  if (!siteRecord.isDemo) {
    reject(
      403,
      "DEMO_SITE_REQUIRED",
      "Demo access is not enabled for this site",
    );
  }
  if (siteRecord.lifecycle === "INACTIVE") {
    reject(409, "SITE_INACTIVE", "Site is inactive");
  }
  const [group] = await db
    .select({ id: guestGroup.id })
    .from(guestGroup)
    .where(and(eq(guestGroup.siteId, siteId), eq(guestGroup.phoneE164, phone)))
    .limit(1);
  if (!group) {
    reject(
      403,
      "DEMO_PHONE_NOT_ALLOWED",
      "Phone is not allowed for demo access",
    );
  }
  const now = options.now ?? new Date();
  return {
    grant: issueDemoGuestGrant({
      siteId,
      phoneE164: phone,
      secret: options.secret,
      now,
    }),
    expiresAt: new Date(now.getTime() + DEMO_GUEST_GRANT_TTL_MS).toISOString(),
  };
}

function problem(status: number, code: string, title: string): Response {
  return new Response(
    JSON.stringify({ type: "about:blank", title, status, code }),
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      },
    },
  );
}

async function readObject(request: Request): Promise<unknown> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return undefined;
  }
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export function createDemoGuestGrantHttpRouter(options: AuthHttpOptions): Hono {
  const router = new Hono();
  router.onError((error) =>
    error instanceof DemoGuestGrantError
      ? problem(error.status, error.code, error.title)
      : problem(503, "SERVICE_UNAVAILABLE", "Service unavailable"),
  );
  router.post("/v1/owner/sites/:siteId/demo/guest-grant", async (context) => {
    if (context.req.header("Origin") !== options.adminOrigin) {
      return problem(403, "FORBIDDEN", "Forbidden");
    }
    let actor: AdministrativeActor;
    try {
      actor = await requireAdminSession(context.req.raw, options);
    } catch (error) {
      if (error instanceof AdminSessionRequiredError) {
        return problem(401, "UNAUTHORIZED", "Authentication required");
      }
      throw error;
    }
    try {
      const input = demoGuestGrantIssueInputSchema.parse(
        await readObject(context.req.raw),
      );
      const result = await issueDemoGuestGrantForSite(
        options.db,
        actor.user,
        context.req.param("siteId"),
        input.phone,
        {
          secret:
            options.guestDemoGrantSecret ??
            options.guestFingerprintSecret ??
            "",
          now: options.now?.(),
          phoneAllowlist: options.guestDemoPhoneAllowlist,
        },
      );
      return new Response(
        JSON.stringify(demoGuestGrantResponseSchema.parse(result)),
        {
          status: 201,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json",
          },
        },
      );
    } catch (error) {
      if (error instanceof DemoGuestGrantError) {
        return problem(error.status, error.code, error.title);
      }
      if (error instanceof Error && error.name === "ZodError") {
        return problem(400, "VALIDATION_ERROR", "Invalid demo grant request");
      }
      throw error;
    }
  });
  router.notFound(() => problem(404, "NOT_FOUND", "Not Found"));
  return router;
}
