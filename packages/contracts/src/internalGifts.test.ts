import { describe, expect, it } from "vitest";
import {
  checkoutCreateInputSchema,
  checkoutStatusInputSchema,
  checkoutStatusResponseSchema,
  financialOverviewSchema,
  financialReauthenticationInputSchema,
  financialReauthenticationResponseSchema,
  giftCreateInputSchema,
  giftMediaFinalizeInputSchema,
  giftMediaFinalizeResponseSchema,
  giftMediaStatusResponseSchema,
  giftMediaUploadInputSchema,
  giftMediaUploadResponseSchema,
  giftPurchaseHistoryDetailResponseSchema,
  giftPurchaseHistoryPageResponseSchema,
  giftPurchaseHistoryPurchaseSchema,
  giftQuoteInputSchema,
  giftQuoteSchema,
  meResponseSchema,
  receivingNominationContextResponseSchema,
  receivingNominationInputSchema,
  receivingNominationResponseSchema,
  receivingReadinessSchema,
  siteAccessSchema,
  siteTeamAcceptInputSchema,
  siteTeamInviteInputSchema,
  withdrawalCreateInputSchema,
  withdrawalListResponseSchema,
  withdrawalPreviewInputSchema,
  withdrawalPreviewSchema,
  withdrawalRequestContextResponseSchema,
  withdrawalRequestStatusResponseSchema,
  withdrawalReservationInputSchema,
  withdrawalResponseSchema,
  withdrawalSealInputSchema,
} from "./index";

const observedAt = "2026-10-12T12:00:00.000Z";

describe("durable withdrawal consent and discovery", () => {
  const preview = {
    siteId: "site-one",
    requestId: "request-one",
    mode: "sandbox",
    currency: "BRL",
    amountCents: 10000,
    feeCents: 500,
    netCents: 9500,
    destinationVersion: 1,
    maskedDestination: "**** 1234",
    operatorDisplayName: "Operator",
    policyVersion: "fees-v1",
    issuedAt: observedAt,
    expiresAt: "2026-10-12T12:01:00.000Z",
  };
  const envelope = {
    siteId: "site-one",
    requestId: "request-one",
    mode: "sandbox",
    requestRevision: "1",
    scopeRevision: "9007199254740993",
    observedAt,
    observationOrder: {
      scopeRevision: "9007199254740993",
      requestRevision: "1",
      recordUpdatedAtMicroseconds: "1791806400000001",
    },
  };
  const command = {
    requestId: "request-one",
    amountCents: 10000,
    destinationVersion: 1,
  };
  it("requires an explicit new-lifecycle ID and exact decimal scope revision", () => {
    const input = {
      requestId: "request-one",
      amountCents: 10000,
      scopeRevision: "9007199254740993",
    };
    expect(withdrawalPreviewInputSchema.parse(input)).toEqual(input);
    for (const scopeRevision of [0, "01", "-1", "1.2", "1e10", ""]) {
      expect(
        withdrawalPreviewInputSchema.safeParse({ ...input, scopeRevision })
          .success,
      ).toBe(false);
    }
    expect(
      withdrawalCreateInputSchema.safeParse({
        ...command,
        reauthenticationToken: `fr1.a.${"b".repeat(43)}`,
      }).success,
    ).toBe(false);
  });
  it("freezes complete conserved terms without mutable lifecycle or authority", () => {
    expect(withdrawalPreviewSchema.parse(preview)).toEqual(preview);
    for (const extra of [
      { state: "OPEN" },
      { scopeRevision: "1" },
      { netCents: 9600 },
      { maskedDestination: "123456789012" },
      { expiresAt: observedAt },
      { bankReference: "private" },
    ]) {
      expect(
        withdrawalPreviewSchema.safeParse({ ...preview, ...extra }).success,
      ).toBe(false);
    }
  });
  it("uses the same exact state response for issue, replay, lookup and seal", () => {
    const open = { ...envelope, state: "OPEN", preview };
    expect(
      withdrawalRequestStatusResponseSchema.parse({ request: open }),
    ).toEqual({ request: open });
    const sealed = {
      ...envelope,
      requestRevision: "2",
      observationOrder: { ...envelope.observationOrder, requestRevision: "2" },
      state: "SEALED_NOT_CREATED",
      command,
      sealedAt: observedAt,
    };
    expect(
      withdrawalRequestStatusResponseSchema.parse({ request: sealed }),
    ).toEqual({ request: sealed });
    for (const extra of [
      { preview: { ...preview, requestId: "other" } },
      { requestRevision: "2" },
      {
        observationOrder: { ...envelope.observationOrder, scopeRevision: "1" },
      },
      { apiKey: "secret" },
    ]) {
      expect(
        withdrawalRequestStatusResponseSchema.safeParse({
          request: { ...open, ...extra },
        }).success,
      ).toBe(false);
    }
    const unresolved = {
      ...envelope,
      requestRevision: null,
      observationOrder: {
        ...envelope.observationOrder,
        requestRevision: null,
        recordUpdatedAtMicroseconds: null,
      },
      state: "UNRESOLVED",
      command: null,
    };
    expect(
      withdrawalRequestStatusResponseSchema.parse({ request: unresolved }),
    ).toEqual({ request: unresolved });
  });
  it("keeps missing or incomplete discovery from claiming new action authority", () => {
    const context = {
      siteId: "site-one",
      mode: "sandbox",
      scopeRevision: "9007199254740993",
      observedAt,
      observationOrder: {
        ...envelope.observationOrder,
        requestRevision: null,
        recordUpdatedAtMicroseconds: null,
      },
      newRequestAllowed: false,
      reason: "OPEN_REQUEST",
      openRequest: { ...envelope, state: "OPEN", preview },
      recoverableRequests: [],
      nextCursor: null,
    };
    expect(withdrawalRequestContextResponseSchema.parse({ context })).toEqual({
      context,
    });
    expect(
      withdrawalRequestContextResponseSchema.safeParse({
        context: { ...context, newRequestAllowed: true },
      }).success,
    ).toBe(false);
    expect(
      withdrawalSealInputSchema.safeParse({
        requestId: "request-one",
        reauthenticationToken: `fr1.a.${"b".repeat(43)}`,
      }).success,
    ).toBe(false);
  });
  it("rejects cross-scope existing terms and unresolved records disguised as allowed discovery", () => {
    const withdrawal = {
      id: "withdrawal-one",
      siteId: "site-one",
      mode: "sandbox",
      amountCents: 10000,
      feeCents: 500,
      netCents: 9500,
      currency: "BRL",
      destinationVersion: 1,
      state: "REQUESTED",
      createdAt: observedAt,
      updatedAt: observedAt,
    };
    const existing = {
      ...envelope,
      requestRevision: "2",
      observationOrder: { ...envelope.observationOrder, requestRevision: "2" },
      state: "EXISTING",
      command,
      withdrawal,
      preview,
    };
    expect(
      withdrawalRequestStatusResponseSchema.parse({ request: existing }),
    ).toEqual({ request: existing });
    for (const extra of [
      { command: { ...command, amountCents: 1 } },
      { withdrawal: { ...withdrawal, mode: "live" } },
      { preview: { ...preview, destinationVersion: 2 } },
    ]) {
      expect(
        withdrawalRequestStatusResponseSchema.safeParse({
          request: { ...existing, ...extra },
        }).success,
      ).toBe(false);
    }
    const unresolved = { ...envelope, state: "UNRESOLVED", command };
    const context = {
      siteId: "site-one",
      mode: "sandbox",
      scopeRevision: envelope.scopeRevision,
      observedAt,
      observationOrder: {
        ...envelope.observationOrder,
        requestRevision: null,
        recordUpdatedAtMicroseconds: null,
      },
      newRequestAllowed: true,
      reason: null,
      openRequest: null,
      recoverableRequests: [unresolved],
      nextCursor: null,
    };
    expect(
      withdrawalRequestContextResponseSchema.safeParse({ context }).success,
    ).toBe(false);
    expect(
      withdrawalRequestStatusResponseSchema.safeParse({
        request: {
          ...existing,
          scopeRevision: "1",
          observationOrder: {
            ...existing.observationOrder,
            scopeRevision: "1",
          },
        },
      }).success,
    ).toBe(false);
  });
  it("rejects contradictory duplicate identities and impossible authoritative observation times", () => {
    const request = {
      ...envelope,
      state: "SEALED_NOT_CREATED",
      requestRevision: "2",
      observationOrder: { ...envelope.observationOrder, requestRevision: "2" },
      command,
      sealedAt: observedAt,
    };
    const withdrawal = {
      id: "withdrawal-one",
      siteId: "site-one",
      mode: "sandbox",
      amountCents: 10000,
      feeCents: 500,
      netCents: 9500,
      currency: "BRL",
      destinationVersion: 1,
      state: "REQUESTED",
      createdAt: observedAt,
      updatedAt: observedAt,
    };
    const existing = {
      ...request,
      state: "EXISTING",
      sealedAt: undefined,
      withdrawal,
      preview: null,
    };
    const { sealedAt: _unused, ...withoutSeal } = existing;
    const context = {
      siteId: "site-one",
      mode: "sandbox",
      scopeRevision: envelope.scopeRevision,
      observedAt,
      observationOrder: {
        ...envelope.observationOrder,
        requestRevision: null,
        recordUpdatedAtMicroseconds: null,
      },
      newRequestAllowed: true,
      reason: null,
      openRequest: null,
      recoverableRequests: [request, withoutSeal],
      nextCursor: null,
    };
    expect(
      withdrawalRequestContextResponseSchema.safeParse({ context }).success,
    ).toBe(false);
    expect(
      withdrawalRequestStatusResponseSchema.safeParse({
        request: { ...request, sealedAt: "2026-10-13T12:00:00.000Z" },
      }).success,
    ).toBe(false);
    expect(
      withdrawalRequestStatusResponseSchema.safeParse({
        request: {
          ...withoutSeal,
          requestRevision: null,
          observationOrder: {
            ...withoutSeal.observationOrder,
            requestRevision: null,
            recordUpdatedAtMicroseconds: null,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      withdrawalRequestStatusResponseSchema.parse({
        request: {
          ...request,
          observationOrder: {
            ...request.observationOrder,
            recordUpdatedAtMicroseconds: String(
              BigInt(Date.parse(observedAt)) * 1000n + 999n,
            ),
          },
        },
      }).request.state,
    ).toBe("SEALED_NOT_CREATED");
  });
  it("rejects malformed decimal and time leaves without throwing from safeParse", () => {
    const sealed = {
      ...envelope,
      state: "SEALED_NOT_CREATED",
      requestRevision: "2",
      observationOrder: { ...envelope.observationOrder, requestRevision: "2" },
      command,
      sealedAt: observedAt,
    };
    for (const extra of [
      { scopeRevision: "invalid" },
      { observedAt: "invalid" },
      { sealedAt: "invalid" },
      {
        observationOrder: {
          ...sealed.observationOrder,
          recordUpdatedAtMicroseconds: "invalid",
        },
      },
      { requestRevision: "invalid" },
    ]) {
      expect(
        withdrawalRequestStatusResponseSchema.safeParse({
          request: { ...sealed, ...extra },
        }).success,
      ).toBe(false);
    }
    expect(
      withdrawalPreviewSchema.safeParse({ ...preview, amountCents: 1.5 })
        .success,
    ).toBe(false);
  });
});

describe("strict receiving nomination context", () => {
  const available = {
    siteId: "site-one",
    mode: "sandbox",
    state: "AVAILABLE",
    requestId: "nr1_original",
    policyVersion: "intent-v1",
  };
  const pending = {
    ...available,
    state: "PENDING",
    currentPolicyVersion: "intent-v2",
    postAllowed: false,
    nomination: {
      siteId: "site-one",
      requestId: "nr1_original",
      state: "AWAITING_PROVIDER_VERIFICATION",
      createdAt: observedAt,
      mode: "sandbox",
    },
  };
  it("accepts empty first context and preserves changed-policy pending identity", () => {
    expect(
      receivingNominationContextResponseSchema.parse({ context: available }),
    ).toEqual({ context: available });
    expect(
      receivingNominationContextResponseSchema.parse({ context: pending }),
    ).toEqual({ context: pending });
  });
  it.each([
    { ...available, apiKey: "private" },
    { ...available, mode: "disabled" },
    { ...pending, postAllowed: true },
    { ...pending, currentPolicyVersion: "intent-v1" },
    { ...pending, nomination: { ...pending.nomination, siteId: "other" } },
    { ...pending, nomination: { ...pending.nomination, requestId: "other" } },
    { ...pending, nomination: { ...pending.nomination, mode: "live" } },
  ])("rejects contradictory or private context %j", (context) => {
    expect(
      receivingNominationContextResponseSchema.safeParse({ context }).success,
    ).toBe(false);
  });
});
const locked = {
  siteId: "wedding-a",
  state: "NOT_CONFIGURED",
  reason: "NOT_CONFIGURED",
  observedAt: null,
  destinationVersion: null,
  catalogEligible: false,
  mode: "disabled",
};

describe("internal gifts C1 contracts", () => {
  it("records a receiving nomination without granting provider approval or exposing its audit", () => {
    const input = {
      requestId: "request-one",
      confirmSelfAsRecipient: true,
      policyVersion: "intent-v1",
      reauthenticationToken: `fr1.${"a".repeat(80)}.${"b".repeat(43)}`,
    };
    expect(receivingNominationInputSchema.parse(input)).toEqual(input);
    for (const extra of [
      { operatorUserId: "other" },
      { accountId: "other" },
      { approved: true },
      { bankVerified: true },
      { state: "READY" },
    ])
      expect(
        receivingNominationInputSchema.safeParse({ ...input, ...extra })
          .success,
      ).toBe(false);
    expect(
      receivingNominationInputSchema.safeParse({
        ...input,
        confirmSelfAsRecipient: false,
      }).success,
    ).toBe(false);
    const response = {
      nomination: {
        siteId: "site-one",
        requestId: "request-one",
        state: "AWAITING_PROVIDER_VERIFICATION",
        createdAt: observedAt,
        mode: "sandbox",
      },
    };
    expect(receivingNominationResponseSchema.parse(response)).toEqual(response);
    expect(
      receivingNominationResponseSchema.safeParse({
        nomination: {
          ...response.nomination,
          authentication: { sessionId: "private" },
        },
      }).success,
    ).toBe(false);
  });
  it("accepts only a password and fixed financial purpose for reauthentication", () => {
    for (const action of ["CONFIGURE_RECEIVING", "REQUEST_WITHDRAWAL"]) {
      const input = { action, password: "test-only-password" };
      expect(financialReauthenticationInputSchema.parse(input)).toEqual(input);
      for (const claim of [
        { userId: "other" },
        { siteId: "other" },
        { sessionId: "other" },
        { verified: true },
        { proofKind: "MFA_REAUTHENTICATION" },
      ])
        expect(
          financialReauthenticationInputSchema.safeParse({ ...input, ...claim })
            .success,
        ).toBe(false);
    }
    for (const password of ["", "x".repeat(201)])
      expect(
        financialReauthenticationInputSchema.safeParse({
          action: "REQUEST_WITHDRAWAL",
          password,
        }).success,
      ).toBe(false);
    const response = {
      reauthenticationToken: `fr1.${"a".repeat(80)}.${"b".repeat(43)}`,
      expiresAt: observedAt,
    };
    expect(financialReauthenticationResponseSchema.parse(response)).toEqual(
      response,
    );
    expect(
      financialReauthenticationResponseSchema.safeParse({
        ...response,
        password: "private",
      }).success,
    ).toBe(false);
  });
  it("preserves the safe locked projection and rejects false READY claims", () => {
    expect(receivingReadinessSchema.parse(locked)).toEqual(locked);
    for (const invalid of [
      { ...locked, catalogEligible: true },
      { ...locked, state: "READY", reason: null, catalogEligible: true },
      { ...locked, walletId: "private-wallet" },
    ]) {
      expect(receivingReadinessSchema.safeParse(invalid).success).toBe(false);
    }
    expect(
      receivingReadinessSchema.parse({
        ...locked,
        state: "READY",
        reason: null,
        observedAt,
        destinationVersion: 1,
        catalogEligible: true,
        mode: "sandbox",
      }).catalogEligible,
    ).toBe(true);
  });

  it("rejects impossible calendar instants instead of normalizing evidence dates", () => {
    expect(
      receivingReadinessSchema.safeParse({
        ...locked,
        observedAt: "2026-02-30T12:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("freezes explicit scoped capability fields without client privilege extras", () => {
    const access = {
      siteId: "wedding-a",
      userId: "helper",
      membershipId: "membership-a",
      membershipRole: "SITE_ASSISTANT",
      capabilities: {
        manageInvitations: true,
        manageMessages: true,
        manageCatalog: true,
        manageTeam: false,
        readFinance: false,
        configureReceiving: false,
        requestWithdrawal: false,
      },
    };
    expect(siteAccessSchema.parse(access)).toEqual(access);
    expect(
      siteAccessSchema.safeParse({ ...access, designatedRecipient: true })
        .success,
    ).toBe(false);
  });

  it("accepts integer BRL catalog values and denies invalid amounts", () => {
    const gift = {
      title: "Jantar especial",
      description: "Presente simbólico",
      nominalCents: 10000,
      currency: "BRL",
      altText: "",
      mediaAssetId: null,
    };
    expect(giftCreateInputSchema.parse(gift)).toEqual(gift);
    for (const nominalCents of [0, -1, 1.2, Number.MAX_SAFE_INTEGER]) {
      expect(
        giftCreateInputSchema.safeParse({ ...gift, nominalCents }).success,
      ).toBe(false);
    }
  });

  it("bounds hashed media declarations and returns only lease or public derivative projections", () => {
    const contentSha256 = "a".repeat(64);
    expect(
      giftMediaUploadInputSchema.parse({
        contentType: "image/png",
        byteLength: 1000,
        contentSha256,
      }),
    ).toEqual({ contentType: "image/png", byteLength: 1000, contentSha256 });
    for (const invalid of [
      { contentType: "image/svg+xml", byteLength: 1000 },
      { contentType: "image/png", byteLength: 5242881 },
      { contentType: "image/png", byteLength: 0 },
      { contentType: "image/png", byteLength: 1.2 },
      { contentType: "image/png", byteLength: 1000, siteId: "other" },
    ]) {
      expect(
        giftMediaUploadInputSchema.safeParse({ ...invalid, contentSha256 })
          .success,
      ).toBe(false);
    }
    const upload = {
      id: "asset-a",
      expiresAt: observedAt,
    };
    expect(giftMediaUploadResponseSchema.parse({ upload })).toEqual({ upload });
    expect(
      giftMediaUploadResponseSchema.safeParse({
        upload: { ...upload, bucket: "private" },
      }).success,
    ).toBe(false);
    const media = {
      id: "asset-a",
      siteId: "wedding-a",
      url: "https://images.example.test/immutable.webp",
      contentType: "image/webp",
      byteLength: 800,
      width: 400,
      height: 400,
    };
    expect(giftMediaFinalizeResponseSchema.parse({ media })).toEqual({ media });
    expect(
      giftMediaFinalizeResponseSchema.safeParse({
        media: {
          ...media,
          url: "https://images.example.test/immutable.webp?signature=private",
        },
      }).success,
    ).toBe(false);
    expect(
      giftMediaFinalizeResponseSchema.safeParse({
        media: { ...media, stagingKey: "uploadable-private" },
      }).success,
    ).toBe(false);
  });

  it.each([
    undefined,
    null,
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "g".repeat(64),
    `${"a".repeat(64)}\n`,
    123,
  ])("rejects missing or noncanonical original hashes %j", (contentSha256) => {
    expect(
      giftMediaUploadInputSchema.safeParse({
        contentType: "image/png",
        byteLength: 1000,
        contentSha256,
      }).success,
    ).toBe(false);
  });

  it("accepts exact bounded metadata for each binary MIME", () => {
    for (const contentType of ["image/jpeg", "image/png", "image/webp"]) {
      const declaration = {
        contentType,
        byteLength: 5_242_880,
        contentSha256: "0123456789abcdef".repeat(4),
      };
      expect(giftMediaUploadInputSchema.parse(declaration)).toEqual(
        declaration,
      );
    }
  });

  it("rejects signed capabilities and private fields in the upload lease", () => {
    const upload = { id: "asset-a", expiresAt: observedAt };
    for (const extra of [
      { putUrl: "https://storage.example.test/staging?signature=private" },
      { headers: { "Content-Type": "image/png" } },
      { contentSha256: "a".repeat(64) },
      { stagingKey: "private" },
      { processingId: "claim" },
      { storageNamespace: "bucket" },
      { secretAccessKey: "private" },
    ]) {
      expect(
        giftMediaUploadResponseSchema.safeParse({
          upload: { ...upload, ...extra },
        }).success,
      ).toBe(false);
    }
    for (const invalid of [
      {},
      { ...upload, id: "../other" },
      { ...upload, expiresAt: "2026-02-30T12:00:00.000Z" },
    ]) {
      expect(
        giftMediaUploadResponseSchema.safeParse({ upload: invalid }).success,
      ).toBe(false);
    }
    expect(
      giftMediaUploadResponseSchema.safeParse({ upload, status: {} }).success,
    ).toBe(false);
  });

  it("distinguishes exact read-only consultation from explicit recovery JSON", () => {
    for (const input of [{}, { action: "RECOVER" }]) {
      expect(giftMediaFinalizeInputSchema.parse(input)).toEqual(input);
    }
    for (const input of [
      null,
      [],
      "RECOVER",
      { action: "CONSULT" },
      { action: "recover" },
      { action: undefined },
      { siteId: "other" },
      { action: "RECOVER", assetId: "other" },
      { contentSha256: "a".repeat(64) },
    ]) {
      expect(giftMediaFinalizeInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it("accepts correlated statuses without dynamic-clock assumptions", () => {
    const media = {
      id: "asset-a",
      siteId: "wedding-a",
      url: "https://images.example.test/immutable.webp",
      contentType: "image/webp",
      byteLength: 800,
      width: 400,
      height: 400,
    };
    for (const state of [
      "PENDING",
      "PROCESSING",
      "FINALIZED",
      "FAILED",
      "EXPIRED",
      "UNKNOWN",
    ]) {
      const status = {
        siteId: media.siteId,
        assetId: media.id,
        state,
        expiresAt: observedAt,
        canRetrySameBytes: false,
        media: state === "FINALIZED" ? media : null,
      };
      expect(giftMediaStatusResponseSchema.parse({ status })).toEqual({
        status,
      });
    }
    for (const state of ["PENDING", "UNKNOWN"]) {
      const status = {
        siteId: media.siteId,
        assetId: media.id,
        state,
        expiresAt: observedAt,
        canRetrySameBytes: true,
        media: null,
      };
      expect(giftMediaStatusResponseSchema.parse({ status })).toEqual({
        status,
      });
    }
  });

  it("rejects contradictory state, retry and finalized-media correlation", () => {
    const media = {
      id: "asset-a",
      siteId: "wedding-a",
      url: "https://images.example.test/immutable.webp",
      contentType: "image/webp",
      byteLength: 800,
      width: 400,
      height: 400,
    };
    const status = {
      siteId: media.siteId,
      assetId: media.id,
      state: "FINALIZED",
      expiresAt: observedAt,
      canRetrySameBytes: false,
      media,
    };
    for (const override of [
      { media: null },
      { media: { ...media, id: "other" } },
      { media: { ...media, siteId: "other" } },
      { canRetrySameBytes: true },
      { state: "CLOSED" },
      { state: "UNKNOWN" },
      { siteId: "../other" },
      { assetId: "" },
      { expiresAt: "bad" },
      { canRetrySameBytes: "false" },
      ...["PROCESSING", "FAILED", "EXPIRED"].map((state) => ({
        state,
        media: null,
        canRetrySameBytes: true,
      })),
    ]) {
      expect(
        giftMediaStatusResponseSchema.safeParse({
          status: { ...status, ...override },
        }).success,
      ).toBe(false);
    }
    for (const state of [
      "PENDING",
      "PROCESSING",
      "FAILED",
      "EXPIRED",
      "UNKNOWN",
    ]) {
      expect(
        giftMediaStatusResponseSchema.safeParse({
          status: { ...status, state },
        }).success,
      ).toBe(false);
    }
    for (const key of Object.keys(status)) {
      const missing: Record<string, unknown> = { ...status };
      delete missing[key];
      expect(
        giftMediaStatusResponseSchema.safeParse({ status: missing }).success,
      ).toBe(false);
    }
  });

  it("excludes private binding, claim, storage and credential fields at every status boundary", () => {
    const media = {
      id: "asset-a",
      siteId: "wedding-a",
      url: "https://images.example.test/immutable.webp",
      contentType: "image/webp",
      byteLength: 800,
      width: 400,
      height: 400,
    };
    const status = {
      siteId: media.siteId,
      assetId: media.id,
      state: "FINALIZED",
      expiresAt: observedAt,
      canRetrySameBytes: false,
      media,
    };
    for (const key of [
      "contentSha256",
      "derivativeSha256",
      "stableObjectVersion",
      "stagingKey",
      "derivativeKey",
      "storageNamespace",
      "processingId",
      "processingExpiresAt",
      "etag",
      "putUrl",
      "accessKeyId",
      "secretAccessKey",
    ]) {
      expect(
        giftMediaStatusResponseSchema.safeParse({ status, [key]: "private" })
          .success,
      ).toBe(false);
      expect(
        giftMediaStatusResponseSchema.safeParse({
          status: { ...status, [key]: "private" },
        }).success,
      ).toBe(false);
      expect(
        giftMediaStatusResponseSchema.safeParse({
          status: { ...status, media: { ...media, [key]: "private" } },
        }).success,
      ).toBe(false);
    }
    expect(giftMediaStatusResponseSchema.safeParse({ media }).success).toBe(
      false,
    );
    expect(giftMediaFinalizeResponseSchema.safeParse({ status }).success).toBe(
      false,
    );
  });

  it("rejects browser pricing and authority overrides in quotes and recoverable checkout", () => {
    expect(
      giftQuoteInputSchema.parse({ giftId: "gift-a", method: "PIX" }),
    ).toEqual({ giftId: "gift-a", method: "PIX" });
    for (const extra of [
      { nominalCents: 1 },
      { walletId: "other-wallet" },
      { readiness: "READY" },
    ]) {
      expect(
        giftQuoteInputSchema.safeParse({
          giftId: "gift-a",
          method: "PIX",
          ...extra,
        }).success,
      ).toBe(false);
      expect(
        checkoutCreateInputSchema.safeParse({
          quoteId: "quote-a",
          requestId: "request-a",
          recoveryToken: "A".repeat(43),
          ...extra,
        }).success,
      ).toBe(false);
    }
  });

  it("conserves the quote allocation and nominal commission independently of total", () => {
    const quote = {
      id: "quote-a",
      giftId: "gift-a",
      siteId: "wedding-a",
      title: "Jantar especial",
      method: "PIX",
      currency: "BRL",
      nominalCents: 10000,
      commissionBasisPoints: 200,
      commissionCents: 200,
      processingCents: 150,
      totalCents: 10350,
      policyVersion: "local-test-v1",
      expiresAt: observedAt,
      mode: "sandbox",
    };
    expect(giftQuoteSchema.parse(quote)).toEqual(quote);
    const recipientQuote = {
      ...quote,
      totalCents: quote.nominalCents,
      feeAllocation: "RECIPIENT_DEDUCTED",
    };
    expect(giftQuoteSchema.parse(recipientQuote)).toEqual(recipientQuote);
    expect(
      giftQuoteSchema.safeParse({ ...recipientQuote, totalCents: 10350 })
        .success,
    ).toBe(false);
    expect(
      giftQuoteSchema.safeParse({ ...recipientQuote, processingCents: 9800 })
        .success,
    ).toBe(false);
    expect(
      giftQuoteSchema.safeParse({ ...recipientQuote, feeAllocation: undefined })
        .success,
    ).toBe(false);

    expect(
      giftQuoteSchema.safeParse({ ...quote, totalCents: 10200 }).success,
    ).toBe(false);
    expect(
      giftQuoteSchema.safeParse({
        ...quote,
        commissionCents: 207,
        totalCents: 10357,
      }).success,
    ).toBe(false);
  });

  it("requires a pre-persisted recovery capability without accepting scope or price overrides", () => {
    const input = {
      quoteId: "quote-a",
      requestId: "request-a",
      recoveryToken: "A".repeat(43),
    };
    expect(checkoutCreateInputSchema.parse(input)).toEqual(input);
    expect(checkoutStatusInputSchema.parse(input)).toEqual(input);
    for (const invalid of [
      { quoteId: input.quoteId, requestId: input.requestId },
      { ...input, recoveryToken: "A".repeat(42) },
      { ...input, recoveryToken: `${"A".repeat(42)}B` },
      { ...input, recoveryToken: `${input.recoveryToken}\n` },
      { ...input, requestId: "request-a\n" },
      { ...input, quoteId: "quote-a\n" },
      { ...input, siteId: "other" },
      { ...input, walletId: "private" },
      { ...input, amountCents: 100 },
    ]) {
      expect(checkoutCreateInputSchema.safeParse(invalid).success).toBe(false);
      expect(checkoutStatusInputSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("keeps uncertain checkout status locked and rejects contradictory hosted or paid claims", () => {
    const status = {
      siteId: "wedding-a",
      quoteId: "quote-a",
      requestId: "request-a",
      orderId: "order-a",
      attemptId: "attempt-a",
      method: "PIX",
      mode: "sandbox",
      state: "OUTCOME_UNKNOWN",
      observedAt: null,
      closedReason: null,
      mayStartNewAttempt: false,
      checkout: null,
    };
    expect(checkoutStatusResponseSchema.parse({ status })).toEqual({ status });
    const confirmed = { ...status, state: "CONFIRMED", observedAt };
    expect(
      checkoutStatusResponseSchema.safeParse({ status: confirmed }).success,
    ).toBe(true);
    for (const override of [
      { observedAt: null },
      { mayStartNewAttempt: true },
      { closedReason: "EXPIRED" },
      {
        checkout: {
          orderId: "order-a",
          attemptId: "attempt-a",
          quoteId: "quote-a",
          method: "PIX",
          mode: "sandbox",
          hostedUrl: "https://checkout.example.test/hosted",
        },
      },
    ]) {
      expect(
        checkoutStatusResponseSchema.safeParse({
          status: { ...confirmed, ...override },
        }).success,
      ).toBe(false);
    }
    for (const invalid of [
      { ...status, mayStartNewAttempt: true },
      { ...status, state: "RECEIVED" },
      { ...status, state: "CLOSED_UNPAID", observedAt },
      { ...status, recoveryToken: "A".repeat(43) },
      { ...status, accountId: "private" },
      { ...status, mode: "disabled" },
    ]) {
      expect(
        checkoutStatusResponseSchema.safeParse({ status: invalid }).success,
      ).toBe(false);
    }
    const checkout = {
      orderId: status.orderId,
      attemptId: status.attemptId,
      quoteId: status.quoteId,
      method: status.method,
      mode: status.mode,
      hostedUrl: "https://checkout.example.test/hosted",
    };
    expect(
      checkoutStatusResponseSchema.safeParse({
        status: {
          ...status,
          state: "AWAITING_PAYMENT",
          observedAt,
          checkout,
        },
      }).success,
    ).toBe(true);
    expect(
      checkoutStatusResponseSchema.safeParse({
        status: {
          ...status,
          state: "AWAITING_PAYMENT",
          observedAt,
          checkout: { ...checkout, quoteId: "other" },
        },
      }).success,
    ).toBe(false);
    expect(
      checkoutStatusResponseSchema.safeParse({
        status: {
          ...status,
          state: "RECEIVED",
          observedAt,
        },
      }).success,
    ).toBe(true);
    expect(
      checkoutStatusResponseSchema.safeParse({
        status: {
          ...status,
          state: "CLOSED_UNPAID",
          observedAt,
          closedReason: "EXPIRED",
          mayStartNewAttempt: true,
        },
      }).success,
    ).toBe(true);
  });

  it("keeps unavailable provider balance unknown and rejects fabricated stale amounts", () => {
    const overview = {
      siteId: "wedding-a",
      currency: "BRL",
      nominalReceivedCents: 0,
      netReceivedCents: 0,
      processingCents: 0,
      commissionCents: 0,
      awaitingReleaseCents: 0,
      availableCents: null,
      pendingCommitmentsCents: 0,
      withdrawnCents: 0,
      refundedCents: 0,
      synchronizedAt: null,
      availability: "UNKNOWN",
      mode: "disabled",
    };
    expect(financialOverviewSchema.parse(overview).availableCents).toBeNull();
    expect(
      financialOverviewSchema.safeParse({
        ...overview,
        availability: "STALE",
        availableCents: 10000,
      }).success,
    ).toBe(false);
    expect(
      financialOverviewSchema.safeParse({
        ...overview,
        availability: "CURRENT",
        availableCents: 10000,
      }).success,
    ).toBe(false);
  });

  it("selects an explicit action and refuses client destination/account/operator selection", () => {
    const input = {
      requestId: "withdrawal-a",
      action: "CONFIRM_NEW",
      reauthenticationToken: `fr1.${"a".repeat(80)}.${"b".repeat(43)}`,
    };
    expect(withdrawalCreateInputSchema.parse(input)).toEqual(input);
    expect(
      withdrawalCreateInputSchema.safeParse({ ...input, destinationVersion: 0 })
        .success,
    ).toBe(false);
    expect(
      withdrawalCreateInputSchema.safeParse({
        ...input,
        accountId: "other",
        operatorId: "owner",
      }).success,
    ).toBe(false);
  });
  it("keeps the strict three-field reservation command separate from proof-bearing transport", () => {
    const command = {
      requestId: "withdrawal.request:one",
      amountCents: 10000,
      destinationVersion: 1,
    };
    expect(withdrawalReservationInputSchema.parse(command)).toEqual(command);
    expect(withdrawalCreateInputSchema.safeParse(command).success).toBe(false);
    const wire = {
      requestId: command.requestId,
      action: "RECOVER_EXISTING",
      reauthenticationToken: `fr1.a.${"b".repeat(43)}`,
    };
    expect(withdrawalCreateInputSchema.parse(wire)).toEqual(wire);
    expect(withdrawalReservationInputSchema.safeParse(wire).success).toBe(
      false,
    );
    expect(withdrawalSealInputSchema.shape.reauthenticationToken).toBe(
      financialReauthenticationResponseSchema.shape.reauthenticationToken,
    );
    for (const extra of [
      { accountId: "private" },
      { operatorUserId: "private" },
      { walletId: "private" },
      { bankReference: "private" },
      { feeCents: 0 },
      { balanceCents: 10000 },
      { mode: "live" },
      { approved: true },
      { recentAuth: { verification: "verified" } },
      { requestHash: "private" },
    ]) {
      expect(
        withdrawalReservationInputSchema.safeParse({ ...command, ...extra })
          .success,
      ).toBe(false);
      expect(
        withdrawalCreateInputSchema.safeParse({ ...wire, ...extra }).success,
      ).toBe(false);
    }
  });
  it.each([
    "",
    undefined,
    null,
    42,
    `fr2.a.${"b".repeat(43)}`,
    `fr1..${"b".repeat(43)}`,
    `fr1.a.${"b".repeat(42)}`,
    `fr1.a.${"b".repeat(44)}`,
    `fr1.a/.${"b".repeat(43)}`,
    `fr1.a=.${"b".repeat(43)}`,
    `fr1.á.${"b".repeat(43)}`,
    `fr1.a.${"b".repeat(43)}\n`,
    `fr1.${"a".repeat(4049)}.${"b".repeat(43)}`,
  ])(
    "rejects invalid withdrawal proof grammar or bounds %#",
    (reauthenticationToken) => {
      expect(
        withdrawalCreateInputSchema.safeParse({
          requestId: "withdrawal-a",
          action: "CONFIRM_NEW",
          reauthenticationToken,
        }).success,
      ).toBe(false);
    },
  );
  it.each([1, 4048])("accepts the shared proof payload bound %s", (length) => {
    const input = {
      requestId: "withdrawal-a",
      action: "CONFIRM_NEW",
      reauthenticationToken: `fr1.${"a".repeat(length)}.${"b".repeat(43)}`,
    };
    expect(withdrawalCreateInputSchema.parse(input)).toEqual(input);
  });
  it("correlates withdrawal success with the original request and preserves private-free history", () => {
    const withdrawal = {
      id: "withdrawal-a",
      siteId: "site-one",
      amountCents: 10000,
      feeCents: 500,
      netCents: 9500,
      currency: "BRL",
      destinationVersion: 1,
      state: "REQUESTED",
      createdAt: observedAt,
      updatedAt: observedAt,
      mode: "sandbox",
    };
    const response = { requestId: "request.original:one", withdrawal };
    expect(withdrawalResponseSchema.parse(response)).toEqual(response);
    expect(withdrawalResponseSchema.safeParse({ withdrawal }).success).toBe(
      false,
    );
    expect(
      withdrawalListResponseSchema.parse({ withdrawals: [withdrawal] }),
    ).toEqual({ withdrawals: [withdrawal] });
    for (const extra of [
      { reauthenticationToken: "private" },
      { requestHash: "private" },
      { accountReference: "private" },
      { authenticationAuditHash: "private" },
    ]) {
      expect(
        withdrawalResponseSchema.safeParse({ ...response, ...extra }).success,
      ).toBe(false);
      expect(
        withdrawalResponseSchema.safeParse({
          ...response,
          withdrawal: { ...withdrawal, ...extra },
        }).success,
      ).toBe(false);
      expect(
        withdrawalListResponseSchema.safeParse({
          withdrawals: [{ ...withdrawal, ...extra }],
        }).success,
      ).toBe(false);
    }
  });

  it("extends session projection with fresh scoped access and restricts team acceptance", () => {
    const actor = {
      user: {
        id: "helper",
        name: "Helper",
        email: "helper@example.test",
        role: "SITE_ASSISTANT",
      },
      session: { id: "session-a", expiresAt: observedAt },
      siteId: null,
      memberships: [],
    };
    expect(meResponseSchema.parse(actor)).toEqual(actor);
    expect(
      siteTeamInviteInputSchema.parse({
        email: " Helper@Example.test ",
        name: " Helper ",
      }),
    ).toEqual({ email: "helper@example.test", name: "Helper" });
    const token = "a".repeat(43);
    expect(siteTeamAcceptInputSchema.parse({ token })).toEqual({ token });
    for (const extra of [
      { role: "SITE_ADMIN" },
      { siteId: "other" },
      { userId: "other" },
    ]) {
      expect(
        siteTeamAcceptInputSchema.safeParse({ token, ...extra }).success,
      ).toBe(false);
    }
  });
});

describe("conservative private purchase history", () => {
  function fixture() {
    const purchase = {
      siteId: "site-one",
      mode: "sandbox",
      orderId: "order-one",
      quoteId: "quote-one",
      giftId: "gift-one",
      titleSnapshot: "Original gift",
      method: "PIX",
      currency: "BRL",
      purchasedAtMicros: "1791806400000000",
      destinationVersion: 1,
      policyVersion: "pricing-original",
      binding: "AVAILABLE",
      quoted: {
        nominalCents: 10000,
        commissionCents: 200,
        processingCents: 500,
        totalCents: 10700,
      },
    };
    const envelope = {
      scope: { siteId: "site-one", mode: "sandbox", policy: "SITE_HISTORY" },
      consistency: "PER_READ",
      readObservedAtMicros: "1791806400000010",
      currentKnowledge: "UNKNOWN",
      sourceOrdering: "UNAVAILABLE",
      nextCursor: null as string | null,
    };
    const payment = {
      paymentId: "payment-one",
      attemptId: "attempt-one",
      orderId: "order-one",
      currency: "BRL",
      recordedState: "UNKNOWN",
      createdAtMicros: "1791806400000001",
      observedAtMicros: null as string | null,
      grossCents: null as number | null,
      processingCents: null as number | null,
      commissionCents: null as number | null,
      recipientNetCents: null as number | null,
    };
    const receipt = {
      effectId: "effect-one",
      paymentId: "receipt-payment",
      orderId: "order-one",
      currency: "BRL",
      recipientCreditCents: 10000,
      postedAtMicros: "1791806400000005",
      sourceObservedAtMicros: "1791806400000002",
      source: "CORRELATED_STORED_POSTING",
    };
    return {
      page: { history: { ...envelope, items: [purchase] } },
      detail: {
        history: {
          ...envelope,
          originalPurchase: purchase,
          coverage: {
            payments: "AVAILABLE",
            receipts: "AVAILABLE",
            reversals: "UNAVAILABLE",
            bankSettlement: "UNAVAILABLE",
          },
          retainedPayments: [payment],
          validatedHistoricalReceipts: [receipt],
        },
      },
    };
  }
  type Fixture = ReturnType<typeof fixture>;
  describe.each(["site.1", "site:1"])(
    "canonical history site identity %s",
    (siteId) => {
      it("rejects the invalid scope even on an empty index", () => {
        const value = fixture().page;
        value.history.scope.siteId = siteId;
        value.history.items = [];
        expect(
          giftPurchaseHistoryPageResponseSchema.safeParse(value).success,
        ).toBe(false);
      });
      it("rejects the invalid original purchase site independently of its envelope", () => {
        expect(
          giftPurchaseHistoryPurchaseSchema.safeParse({
            ...fixture().detail.history.originalPurchase,
            siteId,
          }).success,
        ).toBe(false);
      });
    },
  );
  it("retains the generic purchase and payment identifier grammar", () => {
    const value = fixture().detail;
    value.history.originalPurchase.orderId = "order.1:part";
    value.history.originalPurchase.quoteId = "quote.1:part";
    value.history.retainedPayments[0].orderId = "order.1:part";
    value.history.retainedPayments[0].paymentId = "payment.1:part";
    value.history.retainedPayments[0].attemptId = "attempt.1:part";
    value.history.validatedHistoricalReceipts[0].orderId = "order.1:part";
    value.history.validatedHistoricalReceipts[0].effectId = "effect.1:part";
    expect(giftPurchaseHistoryDetailResponseSchema.parse(value)).toEqual(value);
  });
  it("preserves immutable original quote values and the exact private scope", () => {
    const value = fixture().page;
    expect(giftPurchaseHistoryPageResponseSchema.parse(value)).toEqual(value);
    value.history.items[0].quoted = {
      nominalCents: 10000,
      commissionCents: 300,
      processingCents: 400,
      totalCents: 10700,
    };
    expect(giftPurchaseHistoryPageResponseSchema.parse(value)).toEqual(value);
  });
  it("retains recipient-deducted history without accepting ambiguous unmarked totals", () => {
    const value = fixture().page;
    Object.assign(value.history.items[0].quoted, {
      totalCents: 10000,
      feeAllocation: "RECIPIENT_DEDUCTED",
    });
    expect(giftPurchaseHistoryPageResponseSchema.parse(value)).toEqual(value);
    delete (value.history.items[0].quoted as { feeAllocation?: string })
      .feeAllocation;
    expect(giftPurchaseHistoryPageResponseSchema.safeParse(value).success).toBe(
      false,
    );
  });

  it("retains nullable actual observations beside a separately correlated historical receipt", () => {
    const value = fixture().detail;
    expect(giftPurchaseHistoryDetailResponseSchema.parse(value)).toEqual(value);
    value.history.currentKnowledge = "UNAVAILABLE";
    expect(giftPurchaseHistoryDetailResponseSchema.parse(value)).toEqual(value);
  });
  it("permits a receipt-only page without pretending its payment is absent globally", () => {
    const value = fixture().detail;
    value.history.retainedPayments = [];
    value.history.nextCursor = "opaque-next_1";
    expect(giftPurchaseHistoryDetailResponseSchema.parse(value)).toEqual(value);
  });
  it.each([
    [99, 9940],
    [0, 10039],
  ])(
    "preserves actual fee %i and recipient credit %i beside the frozen quote",
    (fee, net) => {
      const value = fixture().detail;
      value.history.originalPurchase.quoted.processingCents = 39;
      value.history.originalPurchase.quoted.totalCents = 10239;
      const receipt = value.history.validatedHistoricalReceipts[0];
      receipt.recipientCreditCents = net;
      Object.assign(value.history.retainedPayments[0], {
        paymentId: receipt.paymentId,
        recordedState: "RECEIVED",
        observedAtMicros: receipt.sourceObservedAtMicros,
        grossCents: 10239,
        processingCents: fee,
        commissionCents: 200,
        recipientNetCents: net,
      });
      expect(giftPurchaseHistoryDetailResponseSchema.parse(value)).toEqual(
        value,
      );
      expect(value.history.originalPurchase.quoted.processingCents).toBe(39);
      value.history.retainedPayments = [];
      value.history.nextCursor = "opaque-next_1";
      expect(giftPurchaseHistoryDetailResponseSchema.parse(value)).toEqual(
        value,
      );
    },
  );
  it("rejects a receipt-only credit that exceeds gross after the exact commission", () => {
    const value = fixture().detail;
    value.history.retainedPayments = [];
    value.history.validatedHistoricalReceipts[0].recipientCreditCents = 10501;
    expect(
      giftPurchaseHistoryDetailResponseSchema.safeParse(value).success,
    ).toBe(false);
  });
  it("retains genuine zero actual amounts separately from null and the quoted allocation", () => {
    const value = fixture().detail;
    Object.assign(value.history.retainedPayments[0], {
      recordedState: "PENDING",
      grossCents: 10000,
      processingCents: 0,
      commissionCents: 0,
      recipientNetCents: 10000,
      observedAtMicros: "1791806400000002",
    });
    expect(giftPurchaseHistoryDetailResponseSchema.parse(value)).toEqual(value);
  });
  it("accepts an unavailable unbound original without any financial facts", () => {
    const value = fixture().detail;
    value.history.originalPurchase.binding = "UNBOUND";
    value.history.currentKnowledge = "UNAVAILABLE";
    value.history.coverage.payments = "UNAVAILABLE";
    value.history.coverage.receipts = "UNAVAILABLE";
    value.history.retainedPayments = [];
    value.history.validatedHistoricalReceipts = [];
    expect(giftPurchaseHistoryDetailResponseSchema.parse(value)).toEqual(value);
  });
  it("accepts empty per-read navigation without any known financial outcome", () => {
    const value = fixture().page;
    value.history.items = [];
    value.history.readObservedAtMicros = "0";
    expect(giftPurchaseHistoryPageResponseSchema.parse(value)).toEqual(value);
  });
  it.each([
    [
      "foreign site",
      (v: Fixture) => {
        v.page.history.items[0].siteId = "foreign-site";
      },
    ],
    [
      "foreign mode",
      (v: Fixture) => {
        v.page.history.items[0].mode = "live";
      },
    ],
    [
      "disabled mode",
      (v: Fixture) => {
        v.page.history.scope.mode = "disabled";
      },
    ],
    [
      "wrong policy",
      (v: Fixture) => {
        v.page.history.scope.policy = "CURRENT_RECIPIENT";
      },
    ],
    [
      "KNOWN",
      (v: Fixture) => {
        v.page.history.currentKnowledge = "KNOWN";
      },
    ],
    [
      "global snapshot",
      (v: Fixture) => {
        v.page.history.consistency = "ATOMIC_HISTORY";
      },
    ],
    [
      "native ordering",
      (v: Fixture) => {
        v.page.history.sourceOrdering = "VERIFIED";
      },
    ],
    [
      "allocation mismatch",
      (v: Fixture) => {
        v.page.history.items[0].quoted.totalCents = 10701;
      },
    ],
    [
      "zero nominal",
      (v: Fixture) => {
        v.page.history.items[0].quoted.nominalCents = 0;
      },
    ],
    [
      "fractional money",
      (v: Fixture) => {
        v.page.history.items[0].quoted.processingCents = 500.5;
      },
    ],
    [
      "overflow money",
      (v: Fixture) => {
        v.page.history.items[0].quoted.totalCents = 2147483648;
      },
    ],
    [
      "unsafe version",
      (v: Fixture) => {
        v.page.history.items[0].destinationVersion = 2147483648;
      },
    ],
    [
      "future purchase",
      (v: Fixture) => {
        v.page.history.items[0].purchasedAtMicros = "1791806400000011";
      },
    ],
    [
      "duplicate order",
      (v: Fixture) => {
        v.page.history.items.push({
          ...v.page.history.items[0],
          quoteId: "quote-two",
        });
      },
    ],
    [
      "duplicate quote",
      (v: Fixture) => {
        v.page.history.items.push({
          ...v.page.history.items[0],
          orderId: "order-two",
        });
      },
    ],
    [
      "unordered purchase page",
      (v: Fixture) => {
        v.page.history.items.push({
          ...v.page.history.items[0],
          orderId: "order-two",
          quoteId: "quote-two",
          purchasedAtMicros: "1791806400000001",
        });
      },
    ],
    [
      "blank title",
      (v: Fixture) => {
        v.page.history.items[0].titleSnapshot = "   ";
      },
    ],
    [
      "lossy title normalization",
      (v: Fixture) => {
        v.page.history.items[0].titleSnapshot = " Original gift ";
      },
    ],
    [
      "unsafe title controls",
      (v: Fixture) => {
        v.page.history.items[0].titleSnapshot = "Original\u0000gift";
      },
    ],
    [
      "invalid identifier",
      (v: Fixture) => {
        v.page.history.items[0].orderId = "../foreign";
      },
    ],
    [
      "foreign currency",
      (v: Fixture) => {
        v.page.history.items[0].currency = "USD";
      },
    ],
    [
      "raw URL cursor",
      (v: Fixture) => {
        v.page.history.nextCursor = "https://example.test/private";
      },
    ],
    [
      "oversized cursor",
      (v: Fixture) => {
        v.page.history.nextCursor = "a".repeat(257);
      },
    ],
  ])(
    "rejects index %s without changing the original facts",
    (_name, change) => {
      const values = fixture();
      change(values);
      expect(
        giftPurchaseHistoryPageResponseSchema.safeParse(values.page).success,
      ).toBe(false);
    },
  );
  it.each(["01", "-1", "1.5", "1e6", "+1", "", "253402300800000000"])(
    "rejects noncanonical or unsupported microseconds %s without conversion",
    (readObservedAtMicros) => {
      const value = fixture().page;
      value.history.readObservedAtMicros = readObservedAtMicros;
      expect(
        giftPurchaseHistoryPageResponseSchema.safeParse(value).success,
      ).toBe(false);
    },
  );
  it.each([1, 1n, null])(
    "rejects non-string exact microseconds %s",
    (readObservedAtMicros) => {
      expect(
        giftPurchaseHistoryPageResponseSchema.safeParse({
          history: { ...fixture().page.history, readObservedAtMicros },
        }).success,
      ).toBe(false);
    },
  );
  it.each([
    [
      "foreign order payment",
      (v: Fixture) => {
        v.detail.history.retainedPayments[0].orderId = "foreign-order";
      },
    ],
    [
      "foreign order receipt",
      (v: Fixture) => {
        v.detail.history.validatedHistoricalReceipts[0].orderId =
          "foreign-order";
      },
    ],
    [
      "duplicate payment",
      (v: Fixture) => {
        v.detail.history.retainedPayments.push({
          ...v.detail.history.retainedPayments[0],
        });
      },
    ],
    [
      "contradictory payment identity",
      (v: Fixture) => {
        v.detail.history.retainedPayments.push({
          ...v.detail.history.retainedPayments[0],
          grossCents: 5,
        });
      },
    ],
    [
      "duplicate effect",
      (v: Fixture) => {
        v.detail.history.validatedHistoricalReceipts.push({
          ...v.detail.history.validatedHistoricalReceipts[0],
          paymentId: "different-payment",
        });
      },
    ],
    [
      "duplicate credited payment",
      (v: Fixture) => {
        v.detail.history.validatedHistoricalReceipts.push({
          ...v.detail.history.validatedHistoricalReceipts[0],
          effectId: "different-effect",
        });
      },
    ],
    [
      "wrong historical credit",
      (v: Fixture) => {
        const receipt = v.detail.history.validatedHistoricalReceipts[0];
        Object.assign(v.detail.history.retainedPayments[0], {
          paymentId: receipt.paymentId,
          recordedState: "RECEIVED",
          observedAtMicros: receipt.sourceObservedAtMicros,
          grossCents: 10700,
          processingCents: 500,
          commissionCents: 200,
          recipientNetCents: 10000,
        });
        v.detail.history.validatedHistoricalReceipts[0].recipientCreditCents = 9999;
      },
    ],
    [
      "fabricated source label",
      (v: Fixture) => {
        v.detail.history.validatedHistoricalReceipts[0].source =
          "PROVIDER_APPROVED";
      },
    ],
    [
      "unavailable payment facts",
      (v: Fixture) => {
        v.detail.history.coverage.payments = "UNAVAILABLE";
      },
    ],
    [
      "unavailable receipt facts",
      (v: Fixture) => {
        v.detail.history.coverage.receipts = "UNAVAILABLE";
      },
    ],
    [
      "unbound financial facts",
      (v: Fixture) => {
        v.detail.history.originalPurchase.binding = "UNBOUND";
      },
    ],
    [
      "successful reversal coverage",
      (v: Fixture) => {
        v.detail.history.coverage.reversals = "AVAILABLE";
      },
    ],
    [
      "bank receipt coverage",
      (v: Fixture) => {
        v.detail.history.coverage.bankSettlement = "AVAILABLE";
      },
    ],
    [
      "negative actual money",
      (v: Fixture) => {
        v.detail.history.retainedPayments[0].processingCents = -1;
      },
    ],
    [
      "zero actual gross",
      (v: Fixture) => {
        v.detail.history.retainedPayments[0].grossCents = 0;
      },
    ],
    [
      "fractional actual money",
      (v: Fixture) => {
        v.detail.history.retainedPayments[0].grossCents = 0.5;
      },
    ],
    [
      "actual allocation mismatch",
      (v: Fixture) => {
        Object.assign(v.detail.history.retainedPayments[0], {
          grossCents: 10700,
          processingCents: 500,
          commissionCents: 200,
          recipientNetCents: 9999,
        });
      },
    ],
    [
      "future actual observation",
      (v: Fixture) => {
        v.detail.history.retainedPayments[0].observedAtMicros =
          "1791806400000011";
      },
    ],
    [
      "pre-purchase actual observation",
      (v: Fixture) => {
        v.detail.history.retainedPayments[0].observedAtMicros =
          "1791806399999999";
      },
    ],
    [
      "future payment creation",
      (v: Fixture) => {
        v.detail.history.retainedPayments[0].createdAtMicros =
          "1791806400000011";
      },
    ],
    [
      "posting before source",
      (v: Fixture) => {
        v.detail.history.validatedHistoricalReceipts[0].postedAtMicros =
          "1791806400000001";
      },
    ],
    [
      "future posting",
      (v: Fixture) => {
        v.detail.history.validatedHistoricalReceipts[0].postedAtMicros =
          "1791806400000011";
      },
    ],
    [
      "null receipt time",
      (v: Fixture) => {
        Object.assign(v.detail.history.validatedHistoricalReceipts[0], {
          sourceObservedAtMicros: null,
        });
      },
    ],
    [
      "incomparable malformed payment time",
      (v: Fixture) => {
        v.detail.history.retainedPayments[0].observedAtMicros = "1e6";
      },
    ],
    [
      "incomparable malformed receipt time",
      (v: Fixture) => {
        v.detail.history.validatedHistoricalReceipts[0].sourceObservedAtMicros =
          "1e6";
      },
    ],
  ])("rejects detail %s before partial financial success", (_name, change) => {
    const values = fixture();
    change(values);
    expect(
      giftPurchaseHistoryDetailResponseSchema.safeParse(values.detail).success,
    ).toBe(false);
  });
  it("correlates a receipt with the matching retained complete original payment", () => {
    const value = fixture().detail;
    Object.assign(value.history.retainedPayments[0], {
      paymentId: "receipt-payment",
      recordedState: "RECEIVED",
      observedAtMicros: "1791806400000002",
      grossCents: 10700,
      processingCents: 500,
      commissionCents: 200,
      recipientNetCents: 10000,
    });
    expect(giftPurchaseHistoryDetailResponseSchema.parse(value)).toEqual(value);
    value.history.retainedPayments[0].observedAtMicros = "1791806400000003";
    expect(
      giftPurchaseHistoryDetailResponseSchema.safeParse(value).success,
    ).toBe(false);
  });
  it("keeps complete actual divergent allocation distinct from quoted allocation", () => {
    const value = fixture().detail;
    Object.assign(value.history.retainedPayments[0], {
      grossCents: 11000,
      processingCents: 700,
      commissionCents: 300,
      recipientNetCents: 10000,
      observedAtMicros: "1791806400000002",
    });
    expect(giftPurchaseHistoryDetailResponseSchema.parse(value)).toEqual(value);
  });
  it.each([
    "generation",
    "scopeRevision",
    "purchaseRevision",
    "recordRevision",
    "balanceCents",
    "refundableCents",
    "providerAccountReference",
    "operatorUserId",
    "guestEmail",
    "hostedUrl",
    "recoveryToken",
    "rawProof",
  ])(
    "rejects private or unsupported %s at the envelope and every nested boundary",
    (field) => {
      const values = fixture();
      for (const target of [
        values.detail,
        values.detail.history,
        values.detail.history.scope,
        values.detail.history.originalPurchase,
        values.detail.history.originalPurchase.quoted,
        values.detail.history.coverage,
        values.detail.history.retainedPayments[0],
        values.detail.history.validatedHistoricalReceipts[0],
      ]) {
        const value = structuredClone(values.detail);
        const originalTargets = [
          values.detail,
          values.detail.history,
          values.detail.history.scope,
          values.detail.history.originalPurchase,
          values.detail.history.originalPurchase.quoted,
          values.detail.history.coverage,
          values.detail.history.retainedPayments[0],
          values.detail.history.validatedHistoricalReceipts[0],
        ];
        const clonedTargets = [
          value,
          value.history,
          value.history.scope,
          value.history.originalPurchase,
          value.history.originalPurchase.quoted,
          value.history.coverage,
          value.history.retainedPayments[0],
          value.history.validatedHistoricalReceipts[0],
        ];
        Object.assign(clonedTargets[originalTargets.indexOf(target)], {
          [field]: "private-or-unsupported",
        });
        expect(
          giftPurchaseHistoryDetailResponseSchema.safeParse(value).success,
        ).toBe(false);
      }
    },
  );
  it("allows exactly25 original rows and rejects26 without slicing", () => {
    const value = fixture().page;
    value.history.items = Array.from({ length: 25 }, (_, index) => ({
      ...value.history.items[0],
      orderId: `order-${index}`,
      quoteId: `quote-${index}`,
      purchasedAtMicros: (1791806400000000n - BigInt(index)).toString(),
    }));
    expect(giftPurchaseHistoryPageResponseSchema.parse(value)).toEqual(value);
    value.history.items.push({
      ...value.history.items[0],
      orderId: "extra-order",
      quoteId: "extra-quote",
      purchasedAtMicros: "1791806399999974",
    });
    expect(giftPurchaseHistoryPageResponseSchema.safeParse(value).success).toBe(
      false,
    );
  });
  it("limits combined payment and receipt facts to50 without omitting either lane", () => {
    const value = fixture().detail;
    value.history.retainedPayments = Array.from({ length: 49 }, (_, index) => ({
      ...value.history.retainedPayments[0],
      paymentId: `payment-${index}`,
    }));
    expect(giftPurchaseHistoryDetailResponseSchema.parse(value)).toEqual(value);
    value.history.retainedPayments.push({
      ...value.history.retainedPayments[0],
      paymentId: "payment-extra",
    });
    expect(
      giftPurchaseHistoryDetailResponseSchema.safeParse(value).success,
    ).toBe(false);
  });
  it("preserves Unicode titles exactly and rejects an oversized serialized response", () => {
    const value = fixture().page;
    value.history.items[0].titleSnapshot = "Presente 🌺";
    expect(giftPurchaseHistoryPageResponseSchema.parse(value)).toEqual(value);
    value.history.items[0].titleSnapshot = "🌺".repeat(40000);
    expect(
      new TextEncoder().encode(JSON.stringify(value)).byteLength,
    ).toBeGreaterThan(128 * 1024);
    expect(giftPurchaseHistoryPageResponseSchema.safeParse(value).success).toBe(
      false,
    );
  });
});

const catalogC1 = await import("./index");

describe("additive public catalog page C1", () => {
  const maximumPage = Math.floor(Number.MAX_SAFE_INTEGER / 20) + 1;
  function card(index = 0) {
    return {
      id: `gift-${String(index).padStart(3, "0")}`,
      siteId: "site-one",
      title: "Presente 🌺",
      description: "Descrição",
      nominalCents: 10000,
      currency: "BRL" as const,
      image: { url: "https://images.example/gift.webp", alt: "" },
      sortOrder: index,
    };
  }
  function page(total = 1, number = 1) {
    const offset = 20 * (number - 1);
    const totalPages = Math.max(1, Math.ceil(total / 20));
    return {
      siteId: "site-one",
      mode: "sandbox" as const,
      gifts: Array.from(
        { length: Math.max(0, Math.min(20, total - offset)) },
        (_, index) => card(index),
      ),
      page: number,
      pageSize: 20,
      q: "",
      total,
      totalPages,
      hasNext: number < totalPages,
    };
  }

  it("exports immutable active capacity and independent page/query byte limits", () => {
    expect(catalogC1.giftCatalogLimits).toMatchObject({
      activeItems: 200,
      activeStates: ["DRAFT", "PUBLISHED"],
      pageSize: 20,
      maxPage: maximumPage,
      queryBytes: 2048,
      qUnits: 100,
      qBytes: 400,
      imageUrlUnits: 2048,
      jsonBytes: 524288,
    });
    expect(Object.isFrozen(catalogC1.giftCatalogLimits)).toBe(true);
    expect(Object.isFrozen(catalogC1.giftCatalogLimits.activeStates)).toBe(
      true,
    );
  });

  it("defaults numeric page and trims q without NFC, case or internal-space changes", () => {
    expect(catalogC1.publicGiftCatalogQuerySchema.parse({})).toEqual({
      page: 1,
      q: "",
    });
    expect(
      catalogC1.publicGiftCatalogQuerySchema.parse({
        page: 11,
        q: "  Cafe\u0301  Azul  ",
      }),
    ).toEqual({ page: 11, q: "Cafe\u0301  Azul" });
    expect(
      catalogC1.publicGiftCatalogQuerySchema.parse({
        page: maximumPage,
        q: "é".repeat(100),
      }),
    ).toEqual({ page: maximumPage, q: "é".repeat(100) });
    expect(catalogC1.publicGiftCatalogQuerySchema.parse({ q: "%_\\'" }).q).toBe(
      "%_\\'",
    );
  });

  it.each([0, -1, 1.5, NaN, Infinity, "1", null, maximumPage + 1])(
    "rejects unsafe or coerced structured page %s",
    (number) => {
      expect(
        catalogC1.publicGiftCatalogQuerySchema.safeParse({ page: number })
          .success,
      ).toBe(false);
    },
  );
  it.each([
    "x".repeat(101),
    `${" ".repeat(100)}x`,
    "\t x ",
    "x\n",
    "x\u0000",
    "x\u007f",
    "\ud800",
    "\udfff",
  ])("rejects invalid raw q before trimming: %j", (q) => {
    expect(
      catalogC1.publicGiftCatalogQuerySchema.safeParse({ q }).success,
    ).toBe(false);
  });
  it("rejects unknown structured query fields and wrong q types", () => {
    for (const input of [
      { limit: 20 },
      { pageSize: 20 },
      { q: [] },
      { q: null },
    ])
      expect(
        catalogC1.publicGiftCatalogQuerySchema.safeParse(input).success,
      ).toBe(false);
  });

  it.each([
    { total: 0, number: 1 },
    { total: 20, number: 1 },
    { total: 21, number: 2 },
    { total: 200, number: 10 },
    { total: 201, number: 11 },
    { total: 201, number: 12 },
    { total: Number.MAX_SAFE_INTEGER, number: maximumPage },
    { total: 1, number: maximumPage },
  ])(
    "preserves coherent empty, retained legacy and safe-offset pages $total/$number",
    ({ total, number }) => {
      const value = page(total, number);
      expect(
        catalogC1.publicGiftCatalogPageResponseSchema.parse(value),
      ).toEqual(value);
    },
  );

  it("keeps all bounded public fields unchanged and accepts blank alt", () => {
    const value = page(20);
    for (const gift of value.gifts) {
      gift.title = "界".repeat(120);
      gift.description = "界".repeat(2000);
      gift.image.url = `https://images.example/${"界".repeat(2025)}`;
      gift.image.alt = "界".repeat(240);
    }
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    expect(bytes).toBeGreaterThan(128 * 1024);
    expect(bytes).toBeLessThanOrEqual(524288);
    expect(catalogC1.publicGiftCatalogPageResponseSchema.parse(value)).toEqual(
      value,
    );
    const spaced = page();
    spaced.gifts[0].title = "  Presente  ";
    spaced.gifts[0].description = "  Texto\n\t\r  ";
    expect(catalogC1.publicGiftCatalogPageResponseSchema.parse(spaced)).toEqual(
      spaced,
    );
  });

  it.each([
    { title: "" },
    { title: "   " },
    { title: "x".repeat(121) },
    { title: `${" ".repeat(120)}x` },
    { title: "x\n" },
    { title: "\ud800" },
    { description: "x".repeat(2001) },
    { description: "x\u000b" },
    { description: "\udfff" },
    { nominalCents: 0 },
    { nominalCents: 1.5 },
    { currency: "USD" },
    { sortOrder: -1 },
    { sortOrder: Number.MAX_SAFE_INTEGER + 1 },
    { siteId: "other-site" },
    { id: "bad id" },
    { privateKey: "private" },
  ])("rejects an invalid full page card %j", (change) => {
    const value = page();
    Object.assign(value.gifts[0], change);
    expect(
      catalogC1.publicGiftCatalogPageResponseSchema.safeParse(value).success,
    ).toBe(false);
  });

  it.each([
    { url: "http://images.example/gift.webp" },
    { url: "https://user:secret@images.example/gift.webp" },
    { url: "https://images.example/gift.webp?q=1" },
    { url: "https://images.example/gift.webp#part" },
    { url: "https://images.example/gift.webp?" },
    { url: "https://images.example/gift.webp#" },
    { url: `https://images.example/${"x".repeat(2048)}` },
    { url: "https://images.example/\nimage" },
    { url: "https://images.example/\ud800" },
    { alt: "x".repeat(241) },
    { alt: "x\u007f" },
    { alt: "\udfff" },
    { privateKey: "private" },
  ])("rejects invalid page image fields %j", (change) => {
    const value = page();
    Object.assign(value.gifts[0].image, change);
    expect(
      catalogC1.publicGiftCatalogPageResponseSchema.safeParse(value).success,
    ).toBe(false);
  });

  it.each([
    { pageSize: 21 },
    { q: " x " },
    { q: "\u0000" },
    { total: -1 },
    { total: 1.5 },
    { total: Number.MAX_SAFE_INTEGER + 1 },
    { totalPages: 2 },
    { hasNext: true },
    { page: 0 },
    { page: maximumPage + 1 },
    { extra: "private" },
  ])("rejects incoherent or invalid page metadata %j", (change) => {
    expect(
      catalogC1.publicGiftCatalogPageResponseSchema.safeParse({
        ...page(),
        ...change,
      }).success,
    ).toBe(false);
  });

  it("requires every envelope field and refuses legacy/page compatibility unions", () => {
    for (const key of Object.keys(page())) {
      const value: Record<string, unknown> = page();
      delete value[key];
      expect(
        catalogC1.publicGiftCatalogPageResponseSchema.safeParse(value).success,
      ).toBe(false);
    }
    expect(
      catalogC1.publicGiftCatalogPageResponseSchema.safeParse({
        gifts: [card()],
        mode: "sandbox",
      }).success,
    ).toBe(false);
    expect(
      catalogC1.publicGiftCatalogResponseSchema.parse({
        gifts: [card()],
        mode: "sandbox",
      }),
    ).toEqual({ gifts: [card()], mode: "sandbox" });
    expect(
      catalogC1.publicGiftCatalogResponseSchema.safeParse(page()).success,
    ).toBe(false);
  });

  it.each(["\n", "\r", "\u2028", "\u2029"])(
    "rejects trailing line terminators in page ASCII IDs: %j",
    (suffix) => {
      const value = page();
      value.siteId += suffix;
      value.gifts[0].siteId = value.siteId;
      value.gifts[0].id += suffix;
      expect(
        catalogC1.publicGiftCatalogPageResponseSchema.safeParse(value).success,
      ).toBe(false);
    },
  );

  it("requires exact row counts, unique IDs and deterministic numeric/ASCII order", () => {
    const missing = page(20);
    missing.gifts.pop();
    const extra = page(20);
    extra.gifts.push(card(20));
    const duplicate = page(2);
    duplicate.gifts[1].id = duplicate.gifts[0].id;
    const reversed = page(2);
    reversed.gifts.reverse();
    const tie = page(2);
    tie.gifts[1].sortOrder = 0;
    tie.gifts[0].id = "gift-Z";
    tie.gifts[1].id = "gift-a";
    expect(catalogC1.publicGiftCatalogPageResponseSchema.parse(tie)).toEqual(
      tie,
    );
    tie.gifts.reverse();
    for (const value of [missing, extra, duplicate, reversed, tie])
      expect(
        catalogC1.publicGiftCatalogPageResponseSchema.safeParse(value).success,
      ).toBe(false);
  });

  it("enforces the complete canonical serialization bound independently of card validation", async () => {
    const { vi } = await import("vitest");
    // Isolate serialization admission; this synthetic boundary is not raw
    // network evidence and does not weaken the bounded public card schema.
    for (const size of [524288, 524289]) {
      const serialization = vi
        .spyOn(JSON, "stringify")
        .mockReturnValue("x".repeat(size));
      let accepted = false;
      try {
        accepted = catalogC1.publicGiftCatalogPageResponseSchema.safeParse(
          page(),
        ).success;
      } finally {
        serialization.mockRestore();
      }
      expect(accepted).toBe(size === 524288);
    }
  });
});
