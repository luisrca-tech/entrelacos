import { describe, expect, it } from "vitest";
import {
  adminAccessIssueResponseSchema,
  adminCreateInputSchema,
  dateEditInputSchema,
  handoffIssueInputSchema,
  meResponseSchema,
  ownerSiteCreateInputSchema,
  publicAccessConsumeInputSchema,
  siteRecordSchema,
  siteReviewApproveInputSchema,
  siteUpdateInputSchema,
} from "./index";

const site = {
  id: "site-demo",
  repositorySlug: "ana-e-joao",
  provisioningKey: "repo:ana-e-joao",
  displayName: "Ana e João",
  coupleNames: ["Ana", "João"],
  eventDate: "2027-05-22",
  lifecycle: "DRAFT",
  previousLifecycle: null,
  publicationState: "UNPUBLISHED",
  isDemo: false,
  publicUrl: "https://ana-e-joao.example.test",
  trustedOrigins: ["https://ana-e-joao.example.test"],
  reviewApprovedAt: null,
  rsvpDeadlineAt: null,
  rsvpDeadlineTimezone: null,
  termStartsOn: null,
  termEndsOn: null,
  createdAt: "2026-09-11T12:00:00.000Z",
  updatedAt: "2026-09-11T12:00:00.000Z",
};

describe("Block 2 public contracts", () => {
  it("accepts a stable site create payload and rejects role escalation", () => {
    expect(
      ownerSiteCreateInputSchema.parse({
        repositorySlug: "ana-e-joao",
        provisioningKey: "repo:ana-e-joao",
        displayName: "Ana e João",
        coupleNames: ["Ana", "João"],
        eventDate: "2027-05-22",
      }),
    ).toEqual({
      repositorySlug: "ana-e-joao",
      provisioningKey: "repo:ana-e-joao",
      displayName: "Ana e João",
      coupleNames: ["Ana", "João"],
      eventDate: "2027-05-22",
    });

    expect(() =>
      ownerSiteCreateInputSchema.parse({
        repositorySlug: "ana-e-joao",
        provisioningKey: "repo:ana-e-joao",
        displayName: "Ana e João",
        coupleNames: ["Ana", "João"],
        eventDate: "2027-05-22",
        role: "OWNER",
      }),
    ).toThrow();
  });

  it("rejects unsafe URLs and non-origin destinations", () => {
    expect(() =>
      siteUpdateInputSchema.parse({
        publicUrl: "javascript:alert(1)",
      }),
    ).toThrow();
    expect(() =>
      siteUpdateInputSchema.parse({
        trustedOrigins: ["https://site.example.test/path"],
      }),
    ).toThrow();
  });

  it("keeps site output strict and validates lifecycle date edits", () => {
    expect(siteRecordSchema.parse(site)).toEqual(site);
    expect(() =>
      siteRecordSchema.parse({ ...site, password: "secret" }),
    ).toThrow();
    expect(
      dateEditInputSchema.parse({
        eventDate: "2027-05-23",
        termStartsOn: "2027-05-24",
        termEndsOn: "2028-05-23",
      }),
    ).toEqual({
      eventDate: "2027-05-23",
      termStartsOn: "2027-05-24",
      termEndsOn: "2028-05-23",
    });
    expect(siteReviewApproveInputSchema.parse({})).toEqual({});
  });

  it("requires one site-bound admin and one-use token outputs", () => {
    expect(
      adminCreateInputSchema.parse({
        siteId: "site-demo",
        name: "Ana",
        email: "ana@example.test",
      }),
    ).toEqual({
      siteId: "site-demo",
      name: "Ana",
      email: "ana@example.test",
    });
    expect(
      adminAccessIssueResponseSchema.parse({
        userId: "user-1",
        siteId: "site-demo",
        purpose: "ACTIVATION",
        token: "a".repeat(43),
        expiresAt: "2026-09-12T12:00:00.000Z",
      }).token,
    ).toHaveLength(43);
  });

  it("returns a safe actor with optional site context and explicit login consumption", () => {
    expect(
      meResponseSchema.parse({
        user: {
          id: "owner-1",
          name: "Owner",
          email: "owner@example.test",
          role: "OWNER",
        },
        session: {
          id: "session-1",
          expiresAt: "2026-09-12T12:00:00.000Z",
        },
        siteId: null,
      }),
    ).toEqual({
      user: {
        id: "owner-1",
        name: "Owner",
        email: "owner@example.test",
        role: "OWNER",
      },
      session: {
        id: "session-1",
        expiresAt: "2026-09-12T12:00:00.000Z",
      },
      siteId: null,
    });
    expect(
      publicAccessConsumeInputSchema.parse({
        token: "a".repeat(43),
        password: "a-secure-password",
      }),
    ).toEqual({ token: "a".repeat(43), password: "a-secure-password" });
    expect(() =>
      publicAccessConsumeInputSchema.parse({
        token: "a".repeat(43),
        password: "a-secure-password",
        role: "OWNER",
      }),
    ).toThrow();
  });

  it("requires handoff origin to be an exact registered origin", () => {
    expect(
      handoffIssueInputSchema.parse({
        siteId: "site-demo",
        origin: "https://ana-e-joao.example.test",
        challenge: "a".repeat(64),
      }),
    ).toEqual({
      siteId: "site-demo",
      origin: "https://ana-e-joao.example.test",
      challenge: "a".repeat(64),
    });
    expect(() =>
      handoffIssueInputSchema.parse({
        siteId: "site-demo",
        origin: "https://ana-e-joao.example.test/callback",
        challenge: "a".repeat(64),
      }),
    ).toThrow();
  });
});
