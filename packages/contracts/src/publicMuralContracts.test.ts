import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  block5ErrorCodeSchema,
  createPublicSiteMessageRequestSchema,
  createPublicSiteMessageResponseSchema,
  publicMuralResponseSchema,
  siteMessageRecordSchema,
  siteMessagesQuerySchema,
  siteMessagesResponseSchema,
} from "./index";

const instant = "2027-05-01T18:00:00.000Z";
const record = {
  id: "message-1",
  authorName: "Ana Silva",
  text: "Com carinho",
  createdAt: instant,
};

describe("public mural contracts", () => {
  it("trims and bounds the visitor name while preserving the message contract", () => {
    const request = {
      requestId: randomUUID(),
      authorName: "  Ana Silva  ",
      text: "Olá\r\ncom carinho",
    };

    expect(createPublicSiteMessageRequestSchema.parse(request)).toEqual({
      ...request,
      authorName: "Ana Silva",
      text: "Olá\ncom carinho",
    });
    expect(
      createPublicSiteMessageRequestSchema.parse({
        ...request,
        authorName: "😀".repeat(160),
      }).authorName,
    ).toHaveLength(320);
    expect(
      createPublicSiteMessageRequestSchema.parse({
        ...request,
        authorName: " Ana \t\n Silva ",
      }).authorName,
    ).toBe("Ana Silva");
    expect(() =>
      createPublicSiteMessageRequestSchema.parse({
        ...request,
        authorName: "  ",
      }),
    ).toThrow();
    expect(() =>
      createPublicSiteMessageRequestSchema.parse({
        ...request,
        authorName: "😀".repeat(161),
      }),
    ).toThrow();
    expect(() =>
      createPublicSiteMessageRequestSchema.parse({
        ...request,
        authorName: "<b>Ana</b>",
      }),
    ).toThrow();
    expect(() =>
      createPublicSiteMessageRequestSchema.parse({
        ...request,
        authorName: "Ana\u0000 Silva",
      }),
    ).toThrow();
    expect(() =>
      createPublicSiteMessageRequestSchema.parse({
        ...request,
        invitationId: "invitation-1",
      }),
    ).toThrow();
  });

  it("returns an idempotent accepted record", () => {
    const response = {
      requestId: randomUUID(),
      acceptedAt: instant,
      replayed: true,
      message: record,
    };

    expect(createPublicSiteMessageResponseSchema.parse(response)).toEqual(
      response,
    );
  });

  it("keeps public and admin listings per-message and site-scoped", () => {
    expect(
      publicMuralResponseSchema.parse({
        enabled: true,
        messages: [record],
        nextCursor: null,
      }),
    ).toEqual({ enabled: true, messages: [record], nextCursor: null });
    expect(siteMessageRecordSchema.parse(record)).toEqual(record);
    expect(
      siteMessagesResponseSchema.parse({
        messages: [record],
        nextCursor: null,
      }),
    ).toEqual({ messages: [record], nextCursor: null });
    expect(() =>
      publicMuralResponseSchema.parse({
        enabled: true,
        messages: [{ ...record, invitationName: "Família Silva" }],
        nextCursor: null,
      }),
    ).toThrow();
    expect(() =>
      siteMessagesResponseSchema.parse({
        invitations: [],
        nextCursor: null,
      }),
    ).toThrow();
  });

  it("accepts messages already stored when the public mural is disabled", () => {
    expect(
      publicMuralResponseSchema.parse({
        enabled: false,
        messages: [record],
        nextCursor: "next-page",
      }),
    ).toEqual({ enabled: false, messages: [record], nextCursor: "next-page" });
  });

  it("accepts and trims an optional admin author-name search", () => {
    expect(siteMessagesQuerySchema.parse({ search: "  Ana Silva  " })).toEqual({
      search: "Ana Silva",
      limit: 20,
    });
    expect(siteMessagesQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(() =>
      siteMessagesQuerySchema.parse({ search: "a".repeat(161) }),
    ).toThrow();
  });

  it("declares public mural lifecycle and moderation error codes", () => {
    for (const code of [
      "MURAL_DISABLED",
      "SITE_INACTIVE",
      "FORBIDDEN",
      "RATE_LIMITED",
      "MESSAGE_CONFLICT",
      "MESSAGE_REMOVED",
    ]) {
      expect(block5ErrorCodeSchema.parse(code)).toBe(code);
    }
  });
});
