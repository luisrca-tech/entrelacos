import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  block5EndpointPaths,
  familyMessageResponseSchema,
  groupDeleteConfirmationSchema,
  messageMutationInputSchema,
  messageMutationResponseSchema,
  messageTextSchema,
  muralConfigurationSchema,
  publicMuralQuerySchema,
  publicMuralResponseSchema,
  rsvpExportQuerySchema,
  siteMessageBlockInputSchema,
  smsQuotaInputSchema,
  smsUsageResponseSchema,
} from "./index";

const requestId = randomUUID();
const instant = "2027-05-01T18:00:00.000Z";

describe("Block 5 contracts", () => {
  it("accepts Unicode and newlines while enforcing the message boundary", () => {
    expect(
      messageTextSchema.parse("Viva os noivos! 👩‍❤️‍👨\r\nCom carinho."),
    ).toBe("Viva os noivos! 👩‍❤️‍👨\nCom carinho.");
    expect(messageTextSchema.parse("😀".repeat(1_000))).toHaveLength(2_000);
    expect(() => messageTextSchema.parse("😀".repeat(1_001))).toThrow();
    expect(() => messageTextSchema.parse("   \n ")).toThrow();
    expect(() => messageTextSchema.parse("<strong>Olá</strong>")).toThrow();
    expect(() => messageTextSchema.parse("Olá\u0000")).toThrow();
  });

  it("requires revision and UUID idempotency without accepting identity", () => {
    const input = { requestId, expectedRevision: 0, text: "Com carinho" };
    expect(messageMutationInputSchema.parse(input)).toEqual(input);
    expect(() =>
      messageMutationInputSchema.parse({
        ...input,
        authorName: "Pessoa inventada",
      }),
    ).toThrow();
    expect(() =>
      messageMutationInputSchema.parse({ ...input, expectedRevision: -1 }),
    ).toThrow();
  });

  it("keeps family message state explicit and private", () => {
    const message = {
      id: "message-1",
      authorName: "Ana Silva",
      groupName: "Família Silva",
      text: "Com carinho",
      revision: 1,
      createdAt: instant,
      updatedAt: instant,
    };
    expect(
      familyMessageResponseSchema.parse({
        siteId: "site-demo",
        groupId: "group-demo",
        currentRevision: 1,
        canEdit: true,
        readOnlyReason: null,
        message,
      }),
    ).toMatchObject({ message });
    expect(() =>
      familyMessageResponseSchema.parse({
        siteId: "site-demo",
        groupId: "group-demo",
        currentRevision: 1,
        canEdit: true,
        readOnlyReason: null,
        message: { ...message, phone: "+5562999999999" },
      }),
    ).toThrow();
    expect(
      messageMutationResponseSchema.parse({
        requestId,
        acceptedAt: instant,
        result: "APPLIED",
        replayed: false,
        message,
      }),
    ).toMatchObject({ result: "APPLIED" });
  });

  it("defines no-store mural pagination without private guest fields", () => {
    expect(publicMuralQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(
      publicMuralQuerySchema.parse({ cursor: "opaque", limit: "100" }),
    ).toEqual({ cursor: "opaque", limit: 100 });
    expect(() => publicMuralQuerySchema.parse({ limit: 101 })).toThrow();
    expect(
      publicMuralResponseSchema.parse({
        enabled: false,
        messages: [],
        nextCursor: null,
      }),
    ).toEqual({ enabled: false, messages: [], nextCursor: null });
    expect(() =>
      publicMuralResponseSchema.parse({
        enabled: true,
        messages: [
          {
            id: "message-1",
            authorName: "Ana Silva",
            groupName: "Família Silva",
            text: "Olá",
            createdAt: instant,
            updatedAt: instant,
            rsvpState: "CONFIRMED",
          },
        ],
        nextCursor: null,
      }),
    ).toThrow();
  });

  it("requires explicit administration inputs", () => {
    expect(muralConfigurationSchema.parse({ enabled: true })).toEqual({
      enabled: true,
    });
    expect(siteMessageBlockInputSchema.parse({ blocked: true })).toEqual({
      blocked: true,
    });
    expect(
      groupDeleteConfirmationSchema.parse({
        confirmGroupId: "group-1",
        confirmGroupName: "Família Silva",
      }),
    ).toMatchObject({ confirmGroupId: "group-1" });
    expect(() =>
      groupDeleteConfirmationSchema.parse({ confirmGroupId: "group-1" }),
    ).toThrow();
  });

  it("requires export phone intent and accepts only RSVP filters", () => {
    expect(
      rsvpExportQuerySchema.parse({
        requestId,
        includePhone: "false",
        state: "PENDING",
        groupId: "group-1",
      }),
    ).toEqual({
      requestId,
      includePhone: false,
      state: "PENDING",
      groupId: "group-1",
    });
    expect(() => rsvpExportQuerySchema.parse({ requestId })).toThrow();
    expect(() =>
      rsvpExportQuerySchema.parse({
        requestId,
        includePhone: "false",
        includeMessages: "true",
      }),
    ).toThrow();
  });

  it("keeps SMS configuration optional and usage modes separate", () => {
    expect(smsQuotaInputSchema.parse({ monthlyLimit: 0 })).toEqual({
      monthlyLimit: 0,
    });
    expect(() => smsQuotaInputSchema.parse({ monthlyLimit: -1 })).toThrow();
    expect(
      smsUsageResponseSchema.parse({
        siteId: "site-demo",
        timezone: "America/Sao_Paulo",
        periodStart: "2027-05-01T03:00:00.000Z",
        periodEnd: "2027-06-01T03:00:00.000Z",
        monthlyLimit: null,
        alert: "NOT_CONFIGURED",
        realSms: {
          reserved: 0,
          providerAccepted: 0,
          failedFinal: 0,
          unknown: 0,
          consumed: 0,
        },
        simulated: {
          reserved: 2,
          providerAccepted: 1,
          failedFinal: 1,
          unknown: 0,
          consumed: 4,
        },
      }),
    ).toMatchObject({ monthlyLimit: null, alert: "NOT_CONFIGURED" });
  });

  it("freezes the Block 5 route surface", () => {
    expect(Object.values(block5EndpointPaths)).toEqual([
      "GET /v1/public/family/message",
      "PUT /v1/public/family/message",
      "GET /v1/public/sites/:siteId/mural",
      "GET /v1/sites/:siteId/messages",
      "GET /v1/sites/:siteId/mural",
      "PATCH /v1/sites/:siteId/mural",
      "DELETE /v1/sites/:siteId/groups/:groupId/message",
      "PATCH /v1/sites/:siteId/groups/:groupId/message-block",
      "DELETE /v1/sites/:siteId/groups/:groupId",
      "GET /v1/sites/:siteId/reports/rsvp.csv",
      "GET /v1/sites/:siteId/reports/rsvp.pdf",
      "GET /v1/sites/:siteId/sms-usage",
      "PATCH /v1/owner/sites/:siteId/sms-quota",
    ]);
  });
});
