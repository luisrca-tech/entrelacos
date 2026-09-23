import {
  invitationExportQuerySchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { Hono } from "hono";
import type { AuthHttpOptions } from "./authHttp";
import { AdminSessionRequiredError, requireAdminSession } from "./authHttp";
import {
  createInvitationCsv,
  createInvitationPdf,
  type ReportsAdminActor,
  ReportsServiceError,
  readInvitationReport,
} from "./reports";

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

function trustedAdminOrigin(request: Request, adminOrigin: string): boolean {
  return request.headers.get("origin") === adminOrigin;
}

function queryObject(request: Request): Record<string, string> {
  return Object.fromEntries(new URL(request.url).searchParams.entries());
}

async function requireAdminActor(
  request: Request,
  options: AuthHttpOptions,
): Promise<Response | ReportsAdminActor> {
  if (!trustedAdminOrigin(request, options.adminOrigin)) {
    return problem(403, "FORBIDDEN", "Forbidden");
  }
  try {
    const actor = await requireAdminSession(request, options);
    return { userId: actor.user.id, role: actor.user.role };
  } catch (error) {
    if (error instanceof AdminSessionRequiredError) {
      return problem(401, "UNAUTHORIZED", "Authentication required");
    }
    throw error;
  }
}

function serviceError(error: unknown): Response | undefined {
  if (error instanceof ReportsServiceError) {
    return problem(error.status, error.code, error.title);
  }
  if (error instanceof Error && error.name === "ZodError") {
    return problem(400, "VALIDATION_ERROR", "Invalid report request");
  }
  return undefined;
}

function safeSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 128);
  return segment || "site";
}

function attachmentName(
  siteId: string,
  generatedAt: string,
  requestId: string,
  extension: "csv" | "pdf",
): string {
  const utc = generatedAt.replace(/\D/gu, "").slice(0, 14);
  return `entrelacos-invitations-${safeSegment(siteId)}-${utc}-${safeSegment(requestId)}.${extension}`;
}

function binaryResponse(
  bytes: Uint8Array,
  contentType: string,
  filename: string,
): Response {
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": contentType,
    },
  });
}

export function createReportsHttpRouter(options: AuthHttpOptions): Hono {
  const router = new Hono();
  router.onError(
    (error) =>
      serviceError(error) ??
      problem(503, "SERVICE_UNAVAILABLE", "Service unavailable"),
  );

  for (const [extension, contentType] of [
    ["csv", "text/csv; charset=utf-8"],
    ["pdf", "application/pdf"],
  ] as const) {
    router.get(
      `/v1/sites/:siteId/reports/invitations.${extension}`,
      async (context) => {
        const actor = await requireAdminActor(context.req.raw, options);
        if (actor instanceof Response) return actor;
        const siteId = context.req.param("siteId");
        if (!siteIdSchema.safeParse(siteId).success) {
          return problem(400, "VALIDATION_ERROR", "Invalid report request");
        }
        const query = invitationExportQuerySchema.safeParse(
          queryObject(context.req.raw),
        );
        if (!query.success) {
          return problem(400, "VALIDATION_ERROR", "Invalid report request");
        }
        try {
          const report = await readInvitationReport(
            options.db,
            actor,
            siteId,
            query.data,
            options.now?.(),
          );
          const bytes =
            extension === "csv"
              ? createInvitationCsv(report, query.data)
              : await createInvitationPdf(report, query.data);
          return binaryResponse(
            bytes,
            contentType,
            attachmentName(
              siteId,
              report.generatedAt,
              query.data.requestId,
              extension,
            ),
          );
        } catch (error) {
          const response = serviceError(error);
          if (response) return response;
          throw error;
        }
      },
    );
  }

  return router;
}
