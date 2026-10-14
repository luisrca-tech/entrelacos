import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
  .refine((value) => {
    const time = Date.parse(value);
    return (
      Number.isFinite(time) &&
      new Date(time).toISOString() ===
        (value.includes(".") ? value : value.replace("Z", ".000Z"))
    );
  });
const text = (max: number) => z.string().trim().min(1).max(max);
export const giftCentsSchema = z.number().int().min(0).max(2_147_483_647);
export const receivingModeSchema = z.enum(["disabled", "sandbox", "live"]);
export const receivingStateSchema = z.enum([
  "NOT_CONFIGURED",
  "ONBOARDING",
  "UNDER_REVIEW",
  "BANK_VALIDATION_PENDING",
  "READY",
  "BLOCKED",
]);
export const receivingReasonSchema = z.enum([
  "NOT_CONFIGURED",
  "PROVIDER_DISABLED",
  "ONBOARDING_REQUIRED",
  "ACCOUNT_UNDER_REVIEW",
  "BANK_VERIFICATION_REQUIRED",
  "EVIDENCE_STALE",
  "DESTINATION_CHANGED",
  "ENVIRONMENT_MISMATCH",
  "CAPABILITY_UNAVAILABLE",
  "ACCOUNT_BLOCKED",
]);

export const receivingReadinessSchema = z
  .object({
    siteId: id,
    state: receivingStateSchema,
    reason: receivingReasonSchema.nullable(),
    observedAt: instant.nullable(),
    destinationVersion: z.number().int().positive().nullable(),
    catalogEligible: z.boolean(),
    mode: receivingModeSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.state === "READY"
        ? value.catalogEligible &&
          value.reason === null &&
          value.observedAt !== null &&
          value.destinationVersion !== null &&
          value.mode !== "disabled"
        : !value.catalogEligible && value.reason !== null,
    "Readiness must match its evidence projection",
  );
export type ReceivingReadiness = z.infer<typeof receivingReadinessSchema>;
export const receivingReadinessResponseSchema = z
  .object({ readiness: receivingReadinessSchema })
  .strict();

export const siteMembershipRoleSchema = z.enum([
  "SITE_ADMIN",
  "SITE_ASSISTANT",
]);
export const siteCapabilitiesSchema = z
  .object({
    manageInvitations: z.boolean(),
    manageMessages: z.boolean(),
    manageCatalog: z.boolean(),
    manageTeam: z.boolean(),
    readFinance: z.boolean(),
    configureReceiving: z.boolean(),
    requestWithdrawal: z.boolean(),
  })
  .strict();
export const siteAccessSchema = z
  .object({
    siteId: id,
    userId: id,
    membershipId: id.nullable(),
    membershipRole: z.enum(["OWNER", "SITE_ADMIN", "SITE_ASSISTANT"]),
    capabilities: siteCapabilitiesSchema,
  })
  .strict();
export type SiteCapabilities = z.infer<typeof siteCapabilitiesSchema>;
export type SiteAccess = z.infer<typeof siteAccessSchema>;
export const siteAccessResponseSchema = z
  .object({ access: siteAccessSchema })
  .strict();

const teamEmail = z.string().trim().toLowerCase().email().max(254);
const teamToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const siteTeamMemberSchema = z
  .object({
    userId: id,
    siteId: id,
    name: text(160),
    email: teamEmail,
    membershipRole: z.literal("SITE_ASSISTANT"),
    revokedAt: instant.nullable(),
  })
  .strict();
export const siteTeamInvitationSchema = z
  .object({
    id,
    siteId: id,
    email: teamEmail,
    inviteeName: text(160),
    expiresAt: instant,
    consumedAt: instant.nullable(),
    revokedAt: instant.nullable(),
  })
  .strict();
export const siteTeamResponseSchema = z
  .object({
    members: z.array(siteTeamMemberSchema),
    invitations: z.array(siteTeamInvitationSchema),
  })
  .strict();
export const siteTeamInviteInputSchema = z
  .object({ email: teamEmail, name: text(160) })
  .strict();
export const siteTeamInviteResponseSchema = z
  .object({ invitation: siteTeamInvitationSchema, token: teamToken })
  .strict();
export const siteTeamAcceptInputSchema = z
  .object({ token: teamToken, password: z.string().min(6).max(10).optional() })
  .strict();
export const siteTeamAcceptResponseSchema = z.object({ siteId: id }).strict();
export const siteTeamRevokeInputSchema = z.object({}).strict();
export type SiteTeamMember = z.infer<typeof siteTeamMemberSchema>;
export type SiteTeamInvitation = z.infer<typeof siteTeamInvitationSchema>;
export type SiteTeamResponse = z.infer<typeof siteTeamResponseSchema>;

export const giftPublicationStateSchema = z.enum([
  "DRAFT",
  "PUBLISHED",
  "ARCHIVED",
]);
const giftFields = {
  title: text(120),
  description: z.string().trim().max(2000),
  nominalCents: giftCentsSchema.refine((value) => value > 0),
  currency: z.literal("BRL"),
  mediaAssetId: id.nullable(),
  altText: z.string().trim().max(240),
};
export const giftCreateInputSchema = z.object(giftFields).strict();
export const giftUpdateInputSchema = giftCreateInputSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0);
export const giftPublishInputSchema = z
  .object({ publicationState: giftPublicationStateSchema })
  .strict();
export const giftReorderInputSchema = z
  .object({
    giftIds: z
      .array(id)
      .min(1)
      .max(200)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();
export const giftItemSchema = z
  .object({
    ...giftFields,
    id,
    siteId: id,
    sortOrder: z.number().int().min(0),
    publicationState: giftPublicationStateSchema,
    createdAt: instant,
    updatedAt: instant,
  })
  .strict();
const safeImageUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  });
export const publicGiftItemSchema = z
  .object({
    id,
    siteId: id,
    title: giftFields.title,
    description: giftFields.description,
    nominalCents: giftFields.nominalCents,
    currency: z.literal("BRL"),
    image: z
      .object({ url: safeImageUrl, alt: giftFields.altText })
      .strict()
      .nullable(),
    sortOrder: z.number().int().min(0),
  })
  .strict();
export const giftItemResponseSchema = z
  .object({ gift: giftItemSchema })
  .strict();
export const giftCatalogResponseSchema = z
  .object({ gifts: z.array(giftItemSchema) })
  .strict();
export const publicGiftCatalogResponseSchema = z
  .object({ gifts: z.array(publicGiftItemSchema), mode: receivingModeSchema })
  .strict();
export const giftMediaContentTypeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
export const giftMediaUploadInputSchema = z
  .object({
    contentType: giftMediaContentTypeSchema,
    byteLength: z.number().int().min(1).max(5_242_880),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const giftMediaUploadResponseSchema = z
  .object({
    upload: z
      .object({
        id,
        expiresAt: instant,
      })
      .strict(),
  })
  .strict();
export const giftMediaFinalizeInputSchema = z.union([
  z.object({}).strict(),
  z.object({ action: z.literal("RECOVER") }).strict(),
]);
export const giftMediaPublicAssetSchema = z
  .object({
    id,
    siteId: id,
    url: safeImageUrl,
    contentType: z.literal("image/webp"),
    byteLength: z.number().int().min(1).max(5_242_880),
    width: z.number().int().min(1).max(4096),
    height: z.number().int().min(1).max(4096),
  })
  .strict()
  .refine(
    (value) => value.width * value.height <= 16_000_000,
    "Gift media pixel limit exceeded",
  );
export const giftMediaFinalizeResponseSchema = z
  .object({ media: giftMediaPublicAssetSchema })
  .strict();
export const giftMediaStatusStateSchema = z.enum([
  "PENDING",
  "PROCESSING",
  "FINALIZED",
  "FAILED",
  "EXPIRED",
  "UNKNOWN",
]);
export const giftMediaStatusSchema = z
  .object({
    siteId: id,
    assetId: id,
    state: giftMediaStatusStateSchema,
    expiresAt: instant,
    canRetrySameBytes: z.boolean(),
    media: giftMediaPublicAssetSchema.nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.state === "FINALIZED"
        ? value.media !== null &&
          value.media.id === value.assetId &&
          value.media.siteId === value.siteId &&
          !value.canRetrySameBytes
        : value.media === null &&
          (!value.canRetrySameBytes ||
            value.state === "PENDING" ||
            value.state === "UNKNOWN"),
    "Gift media status must match its correlated result and retry state",
  );
export const giftMediaStatusResponseSchema = z
  .object({ status: giftMediaStatusSchema })
  .strict();
export type GiftMediaUploadInput = z.infer<typeof giftMediaUploadInputSchema>;
export type GiftMediaFinalizeInput = z.infer<
  typeof giftMediaFinalizeInputSchema
>;
export type GiftMediaFinalizeResponse = z.infer<
  typeof giftMediaFinalizeResponseSchema
>;
export type GiftMediaStatusState = z.infer<typeof giftMediaStatusStateSchema>;
export type GiftMediaStatus = z.infer<typeof giftMediaStatusSchema>;
export type GiftMediaStatusResponse = z.infer<
  typeof giftMediaStatusResponseSchema
>;
export type GiftMediaPublicAsset = z.infer<typeof giftMediaPublicAssetSchema>;
export type GiftMediaUploadResponse = z.infer<
  typeof giftMediaUploadResponseSchema
>;
export type GiftItem = z.infer<typeof giftItemSchema>;
export type PublicGiftItem = z.infer<typeof publicGiftItemSchema>;
export type GiftCreateInput = z.infer<typeof giftCreateInputSchema>;
export type GiftUpdateInput = z.infer<typeof giftUpdateInputSchema>;

export const giftPaymentMethodSchema = z.enum(["PIX", "CREDIT_CARD"]);
export const giftQuoteInputSchema = z
  .object({ giftId: id, method: giftPaymentMethodSchema })
  .strict();
export const giftQuoteSchema = z
  .object({
    id,
    giftId: id,
    siteId: id,
    title: giftFields.title,
    method: giftPaymentMethodSchema,
    currency: z.literal("BRL"),
    nominalCents: giftFields.nominalCents,
    commissionBasisPoints: z.literal(200),
    commissionCents: giftCentsSchema,
    processingCents: giftCentsSchema,
    totalCents: giftCentsSchema,
    policyVersion: id,
    expiresAt: instant,
    mode: receivingModeSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.totalCents ===
        value.nominalCents + value.commissionCents + value.processingCents &&
      value.commissionCents === Math.round((value.nominalCents * 200) / 10000),
    "Quote allocation does not match the nominal commission",
  );
export type GiftQuote = z.infer<typeof giftQuoteSchema>;
export const giftQuoteResponseSchema = z
  .object({ quote: giftQuoteSchema })
  .strict();
export const checkoutRecoveryTokenSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const checkoutCreateInputSchema = z
  .object({
    quoteId: id,
    requestId: id,
    recoveryToken: checkoutRecoveryTokenSchema,
  })
  .strict();
export const checkoutStatusInputSchema = checkoutCreateInputSchema;
export type CheckoutCreateInput = z.infer<typeof checkoutCreateInputSchema>;
export type CheckoutStatusInput = z.infer<typeof checkoutStatusInputSchema>;
export const checkoutResultSchema = z
  .object({
    orderId: id,
    attemptId: id,
    quoteId: id,
    method: giftPaymentMethodSchema,
    hostedUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      }),
    mode: receivingModeSchema,
  })
  .strict();
export type CheckoutResult = z.infer<typeof checkoutResultSchema>;
export const checkoutResponseSchema = z
  .object({ checkout: checkoutResultSchema })
  .strict();

export const checkoutStatusSchema = z
  .object({
    siteId: id,
    quoteId: id,
    requestId: id,
    orderId: id,
    attemptId: id,
    method: giftPaymentMethodSchema,
    mode: z.enum(["sandbox", "live"]),
    state: z.enum([
      "CREATING",
      "OUTCOME_UNKNOWN",
      "AWAITING_PAYMENT",
      "RECEIVED",
      "CLOSED_UNPAID",
      "REFUNDED",
    ]),
    observedAt: instant.nullable(),
    closedReason: z.enum(["FAILED", "EXPIRED", "CANCELED"]).nullable(),
    mayStartNewAttempt: z.boolean(),
    checkout: checkoutResultSchema.nullable(),
  })
  .strict()
  .refine((value) => {
    if (value.mayStartNewAttempt !== (value.state === "CLOSED_UNPAID"))
      return false;
    if ((value.closedReason !== null) !== (value.state === "CLOSED_UNPAID"))
      return false;
    if (
      value.state !== "CREATING" &&
      value.state !== "OUTCOME_UNKNOWN" &&
      value.observedAt === null
    )
      return false;
    if (value.state !== "AWAITING_PAYMENT") return value.checkout === null;
    const checkout = value.checkout;
    return (
      checkout !== null &&
      checkout.orderId === value.orderId &&
      checkout.attemptId === value.attemptId &&
      checkout.quoteId === value.quoteId &&
      checkout.method === value.method &&
      checkout.mode === value.mode
    );
  }, "Contradictory checkout status");
export type CheckoutStatus = z.infer<typeof checkoutStatusSchema>;
export const checkoutStatusResponseSchema = z
  .object({ status: checkoutStatusSchema })
  .strict();

export const financialOverviewSchema = z
  .object({
    siteId: id,
    currency: z.literal("BRL"),
    nominalReceivedCents: giftCentsSchema,
    netReceivedCents: giftCentsSchema,
    processingCents: giftCentsSchema,
    commissionCents: giftCentsSchema,
    awaitingReleaseCents: giftCentsSchema,
    availableCents: giftCentsSchema.nullable(),
    pendingCommitmentsCents: giftCentsSchema,
    withdrawnCents: giftCentsSchema,
    refundedCents: giftCentsSchema,
    synchronizedAt: instant.nullable(),
    availability: z.enum(["CURRENT", "STALE", "UNKNOWN"]),
    mode: receivingModeSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.availability === "CURRENT"
        ? value.availableCents !== null && value.synchronizedAt !== null
        : value.availableCents === null,
    "Unavailable provider balance must remain unknown",
  );
export type FinancialOverview = z.infer<typeof financialOverviewSchema>;
export const financialOverviewResponseSchema = z
  .object({ overview: financialOverviewSchema })
  .strict();
export const withdrawalStateSchema = z.enum([
  "REQUESTED",
  "AWAITING_AUTHORIZATION",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "UNKNOWN",
]);
export const withdrawalReservationInputSchema = z
  .object({
    requestId: id,
    amountCents: giftFields.nominalCents,
    destinationVersion: z.number().int().positive(),
  })
  .strict();
export type WithdrawalReservationInput = z.infer<
  typeof withdrawalReservationInputSchema
>;
export const withdrawalIntentSchema = z
  .object({
    id,
    siteId: id,
    amountCents: giftFields.nominalCents,
    feeCents: giftCentsSchema,
    netCents: giftFields.nominalCents,
    currency: z.literal("BRL"),
    destinationVersion: z.number().int().positive(),
    state: withdrawalStateSchema,
    createdAt: instant,
    updatedAt: instant,
    mode: receivingModeSchema,
  })
  .strict()
  .refine(
    (value) => value.netCents + value.feeCents === value.amountCents,
    "Withdrawal amount must cover fees and recipient net",
  );
export type WithdrawalIntent = z.infer<typeof withdrawalIntentSchema>;
export const withdrawalResponseSchema = z
  .object({ requestId: id, withdrawal: withdrawalIntentSchema })
  .strict();
export const withdrawalListResponseSchema = z
  .object({ withdrawals: z.array(withdrawalIntentSchema) })
  .strict();

export const financialReauthenticationActionSchema = z.enum([
  "CONFIGURE_RECEIVING",
  "REQUEST_WITHDRAWAL",
]);
export const financialReauthenticationInputSchema = z
  .object({
    action: financialReauthenticationActionSchema,
    password: z.string().min(1).max(200),
  })
  .strict();
export const financialReauthenticationResponseSchema = z
  .object({
    reauthenticationToken: z
      .string()
      .max(4096)
      .regex(/^fr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/),
    expiresAt: instant,
  })
  .strict();

export const withdrawalCreateInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("CONFIRM_NEW"),
      requestId: id,
      reauthenticationToken:
        financialReauthenticationResponseSchema.shape.reauthenticationToken,
    })
    .strict(),
  z
    .object({
      action: z.literal("RECOVER_EXISTING"),
      requestId: id,
      reauthenticationToken:
        financialReauthenticationResponseSchema.shape.reauthenticationToken,
    })
    .strict(),
]);
export type WithdrawalCreateInput = z.infer<typeof withdrawalCreateInputSchema>;

const withdrawalRevision = z
  .string()
  .max(128)
  .regex(/^(?:0|[1-9][0-9]*)$/);
const withdrawalActiveMode = z.enum(["sandbox", "live"]);
export const withdrawalPreviewInputSchema = z
  .object({
    requestId: id,
    amountCents: giftFields.nominalCents,
    scopeRevision: withdrawalRevision,
  })
  .strict();
export type WithdrawalPreviewInput = z.infer<
  typeof withdrawalPreviewInputSchema
>;
export const withdrawalSealInputSchema = z
  .object({
    reauthenticationToken:
      financialReauthenticationResponseSchema.shape.reauthenticationToken,
  })
  .strict();
export type WithdrawalSealInput = z.infer<typeof withdrawalSealInputSchema>;
export const withdrawalPreviewSchema = z
  .object({
    siteId: id,
    requestId: id,
    mode: withdrawalActiveMode,
    currency: z.literal("BRL"),
    amountCents: giftFields.nominalCents,
    feeCents: giftCentsSchema,
    netCents: giftFields.nominalCents,
    destinationVersion: z.number().int().positive(),
    maskedDestination: z
      .string()
      .max(120)
      .regex(/^(?:[A-Za-zÀ-ÿ .-]{1,60} )?(?:\*{4}|•{4}) [0-9]{4}$/),
    operatorDisplayName: z
      .string()
      .min(1)
      .max(120)
      .refine(
        (value) =>
          value === value.trim() &&
          [...value].every(
            (character) =>
              character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
          ),
      ),
    policyVersion: id,
    issuedAt: instant,
    expiresAt: instant,
  })
  .strict()
  .refine(
    (value) =>
      [value.feeCents, value.netCents, value.amountCents].every(
        Number.isSafeInteger,
      ) &&
      BigInt(value.feeCents) + BigInt(value.netCents) ===
        BigInt(value.amountCents) &&
      Date.parse(value.expiresAt) > Date.parse(value.issuedAt),
    "Invalid immutable withdrawal terms",
  );
export type WithdrawalPreview = z.infer<typeof withdrawalPreviewSchema>;
const withdrawalObservationOrderSchema = z
  .object({
    scopeRevision: withdrawalRevision,
    requestRevision: withdrawalRevision.nullable(),
    recordUpdatedAtMicroseconds: withdrawalRevision.nullable(),
  })
  .strict();
const withdrawalRequestEnvelope = {
  siteId: id,
  requestId: id,
  mode: withdrawalActiveMode,
  requestRevision: withdrawalRevision.nullable(),
  scopeRevision: withdrawalRevision,
  observedAt: instant,
  observationOrder: withdrawalObservationOrderSchema,
};
export const withdrawalRequestStatusSchema = z
  .discriminatedUnion("state", [
    z
      .object({
        ...withdrawalRequestEnvelope,
        state: z.literal("OPEN"),
        requestRevision: z.literal("1"),
        preview: withdrawalPreviewSchema,
      })
      .strict(),
    z
      .object({
        ...withdrawalRequestEnvelope,
        state: z.literal("EXISTING"),
        command: withdrawalReservationInputSchema,
        withdrawal: withdrawalIntentSchema,
        preview: withdrawalPreviewSchema.nullable(),
      })
      .strict(),
    z
      .object({
        ...withdrawalRequestEnvelope,
        state: z.literal("SEALED_NOT_CREATED"),
        requestRevision: z.literal("2"),
        command: withdrawalReservationInputSchema,
        sealedAt: instant,
      })
      .strict(),
    z
      .object({
        ...withdrawalRequestEnvelope,
        state: z.literal("UNRESOLVED"),
        command: withdrawalReservationInputSchema.nullable(),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    // Refinements also run on dirty leaves; validate before exact arithmetic.
    if (
      !withdrawalRevision.safeParse(value.scopeRevision).success ||
      !withdrawalObservationOrderSchema.safeParse(value.observationOrder)
        .success ||
      !instant.safeParse(value.observedAt).success ||
      (value.requestRevision !== null &&
        !withdrawalRevision.safeParse(value.requestRevision).success)
    )
      return;
    if (
      value.state === "OPEN" &&
      !instant.safeParse(value.preview.issuedAt).success
    )
      return;
    if (
      value.state === "SEALED_NOT_CREATED" &&
      !instant.safeParse(value.sealedAt).success
    )
      return;
    if (
      value.state === "EXISTING" &&
      (!instant.safeParse(value.withdrawal.createdAt).success ||
        !instant.safeParse(value.withdrawal.updatedAt).success)
    )
      return;
    const reject = () =>
      context.addIssue({
        code: "custom",
        message: "Contradictory withdrawal request scope",
      });
    const recordMicros =
      value.observationOrder.recordUpdatedAtMicroseconds === null
        ? null
        : BigInt(value.observationOrder.recordUpdatedAtMicroseconds);
    if (
      recordMicros !== null &&
      recordMicros > BigInt(Date.parse(value.observedAt)) * 1000n + 999n
    )
      reject();
    if (
      value.state === "OPEN" &&
      (Date.parse(value.preview.issuedAt) > Date.parse(value.observedAt) ||
        recordMicros === null ||
        recordMicros < BigInt(Date.parse(value.preview.issuedAt)) * 1000n)
    )
      reject();
    if (
      value.state === "SEALED_NOT_CREATED" &&
      (recordMicros === null ||
        BigInt(Date.parse(value.sealedAt)) * 1000n > recordMicros)
    )
      reject();
    if (
      value.observationOrder.scopeRevision !== value.scopeRevision ||
      value.observationOrder.requestRevision !== value.requestRevision ||
      (value.requestRevision !== null &&
        !["1", "2"].includes(value.requestRevision)) ||
      (value.requestRevision !== null &&
        BigInt(value.scopeRevision) < BigInt(value.requestRevision)) ||
      (value.requestRevision !== null &&
        value.observationOrder.recordUpdatedAtMicroseconds === null)
    )
      reject();
    if (
      value.state === "OPEN" &&
      (value.preview.requestId !== value.requestId ||
        value.preview.siteId !== value.siteId ||
        value.preview.mode !== value.mode)
    )
      reject();
    if (
      value.state !== "OPEN" &&
      value.command &&
      value.command.requestId !== value.requestId
    )
      reject();
    if (value.state === "EXISTING") {
      const { withdrawal, command, preview } = value;
      if (
        recordMicros === null ||
        Date.parse(withdrawal.createdAt) > Date.parse(withdrawal.updatedAt) ||
        BigInt(Date.parse(withdrawal.updatedAt)) * 1000n > recordMicros
      )
        reject();
      if (value.requestRevision !== null && value.requestRevision !== "2")
        reject();
      if (
        withdrawal.siteId !== value.siteId ||
        withdrawal.mode !== value.mode ||
        withdrawal.amountCents !== command.amountCents ||
        withdrawal.destinationVersion !== command.destinationVersion
      )
        reject();
      if (
        preview &&
        (value.requestRevision !== "2" ||
          preview.requestId !== value.requestId ||
          preview.siteId !== value.siteId ||
          preview.mode !== value.mode ||
          preview.amountCents !== withdrawal.amountCents ||
          preview.feeCents !== withdrawal.feeCents ||
          preview.netCents !== withdrawal.netCents ||
          preview.destinationVersion !== withdrawal.destinationVersion)
      )
        reject();
    }
  });
export type WithdrawalRequestStatus = z.infer<
  typeof withdrawalRequestStatusSchema
>;
export const withdrawalRequestStatusResponseSchema = z
  .object({ request: withdrawalRequestStatusSchema })
  .strict();
export type WithdrawalRequestStatusResponse = z.infer<
  typeof withdrawalRequestStatusResponseSchema
>;
export const withdrawalRequestContextSchema = z
  .object({
    siteId: id,
    mode: withdrawalActiveMode,
    scopeRevision: withdrawalRevision,
    observedAt: instant,
    observationOrder: withdrawalObservationOrderSchema,
    newRequestAllowed: z.boolean(),
    reason: z
      .enum([
        "OPEN_REQUEST",
        "UNRESOLVED_OPERATION",
        "RECIPIENT_REQUIRED",
        "DESTINATION_UNAVAILABLE",
        "NOT_CONFIGURED",
        "CONTEXT_UNAVAILABLE",
      ])
      .nullable(),
    openRequest: withdrawalRequestStatusSchema.nullable(),
    recoverableRequests: z.array(withdrawalRequestStatusSchema).max(100),
    nextCursor: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9._:-]+$/)
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const reject = () =>
      context.addIssue({
        code: "custom",
        message: "Contradictory withdrawal discovery",
      });
    if (
      value.observationOrder.scopeRevision !== value.scopeRevision ||
      value.observationOrder.requestRevision !== null ||
      value.observationOrder.recordUpdatedAtMicroseconds !== null ||
      value.newRequestAllowed !== (value.reason === null)
    )
      reject();
    if (
      value.openRequest &&
      (value.openRequest.state !== "OPEN" ||
        value.newRequestAllowed ||
        value.reason !== "OPEN_REQUEST")
    )
      reject();
    if (value.reason === "OPEN_REQUEST" && value.openRequest === null) reject();
    if (
      value.recoverableRequests.some(
        (request) =>
          request.state === "OPEN" ||
          (value.newRequestAllowed &&
            (request.state === "UNRESOLVED" ||
              (request.state === "EXISTING" &&
                request.withdrawal.state === "UNKNOWN"))),
      )
    )
      reject();
    for (const request of [
      ...(value.openRequest ? [value.openRequest] : []),
      ...value.recoverableRequests,
    ]) {
      if (
        request.siteId !== value.siteId ||
        request.mode !== value.mode ||
        request.scopeRevision !== value.scopeRevision
      )
        reject();
    }
    const requests = [
      ...(value.openRequest ? [value.openRequest] : []),
      ...value.recoverableRequests,
    ];
    if (
      new Set(requests.map((request) => request.requestId)).size !==
      requests.length
    )
      reject();
  });
export type WithdrawalRequestContext = z.infer<
  typeof withdrawalRequestContextSchema
>;
export const withdrawalRequestContextResponseSchema = z
  .object({ context: withdrawalRequestContextSchema })
  .strict();
export type WithdrawalRequestContextResponse = z.infer<
  typeof withdrawalRequestContextResponseSchema
>;

export const receivingNominationInputSchema = z
  .object({
    requestId: id,
    confirmSelfAsRecipient: z.literal(true),
    policyVersion: id,
    reauthenticationToken:
      financialReauthenticationResponseSchema.shape.reauthenticationToken,
  })
  .strict();
export const receivingNominationResponseSchema = z
  .object({
    nomination: z
      .object({
        siteId: id,
        requestId: id,
        state: z.literal("AWAITING_PROVIDER_VERIFICATION"),
        createdAt: instant,
        mode: z.enum(["sandbox", "live"]),
      })
      .strict(),
  })
  .strict();

const nominationContextBinding = {
  siteId: id,
  mode: z.enum(["sandbox", "live"]),
  requestId: id,
  policyVersion: id,
};
export const receivingNominationContextSchema = z
  .discriminatedUnion("state", [
    z
      .object({ ...nominationContextBinding, state: z.literal("AVAILABLE") })
      .strict(),
    z
      .object({
        ...nominationContextBinding,
        state: z.literal("PENDING"),
        currentPolicyVersion: id,
        postAllowed: z.boolean(),
        nomination: receivingNominationResponseSchema.shape.nomination,
      })
      .strict(),
  ])
  .refine(
    (value) =>
      value.state !== "PENDING" ||
      (value.nomination.siteId === value.siteId &&
        value.nomination.requestId === value.requestId &&
        value.nomination.mode === value.mode &&
        value.postAllowed ===
          (value.policyVersion === value.currentPolicyVersion)),
  );
export type ReceivingNominationContext = z.infer<
  typeof receivingNominationContextSchema
>;
export const receivingNominationContextResponseSchema = z
  .object({ context: receivingNominationContextSchema })
  .strict();
export type ReceivingNominationContextResponse = z.infer<
  typeof receivingNominationContextResponseSchema
>;

export const internalGiftsProblemCodeSchema = z.enum([
  "MEMBERSHIP_DENIED",
  "RECEIVING_NOT_READY",
  "DESTINATION_UNVERIFIED",
  "PROVIDER_MODE_UNAVAILABLE",
  "POLICY_UNAVAILABLE",
  "QUOTE_INVALID",
  "QUOTE_EXPIRED",
  "AVAILABILITY_STALE",
  "INSUFFICIENT_FUNDS",
  "REQUEST_CONFLICT",
  "EXTERNAL_OUTCOME_UNKNOWN",
  "RECENT_AUTH_REQUIRED",
  "RECIPIENT_REQUIRED",
  "REAUTHENTICATION_RATE_LIMITED",
  "REAUTHENTICATION_UNAVAILABLE",
  "NOMINATION_INVALID",
  "RECIPIENT_CONFLICT",
  "RECEIVING_BINDING_EXISTS",
  "RECEIVING_NOMINATION_UNAVAILABLE",
]);
export const internalGiftsEndpointPaths = {
  asaasWebhook: "POST /v1/webhooks/asaas",
  readiness: "GET /v1/sites/:siteId/receiving/readiness",
  financialReauthentication:
    "POST /v1/sites/:siteId/financial-reauthentication",
  receivingNomination: "POST /v1/sites/:siteId/receiving/nomination",
  receivingNominationContext:
    "GET /v1/sites/:siteId/receiving/nomination-context",
  access: "GET /v1/sites/:siteId/access",
  teamRead: "GET /v1/sites/:siteId/team",
  teamInvite: "POST /v1/sites/:siteId/team/invitations",
  teamInvitationRevoke:
    "POST /v1/sites/:siteId/team/invitations/:invitationId/revoke",
  teamMemberRevoke: "POST /v1/sites/:siteId/team/members/:userId/revoke",
  teamAccept: "POST /v1/team-invitations/accept",
  giftsRead: "GET /v1/sites/:siteId/gifts",
  giftsCreate: "POST /v1/sites/:siteId/gifts",
  giftUpdate: "PATCH /v1/sites/:siteId/gifts/:giftId",
  giftPublication: "PATCH /v1/sites/:siteId/gifts/:giftId/publication",
  giftsReorder: "POST /v1/sites/:siteId/gifts/reorder",
  publicGifts: "GET /v1/public/sites/:siteId/gifts",
  mediaUpload: "POST /v1/sites/:siteId/gift-media/uploads",
  mediaFinalize: "POST /v1/sites/:siteId/gift-media/:assetId/finalize",
  quote: "POST /v1/public/sites/:siteId/gift-quotes",
  checkout: "POST /v1/public/sites/:siteId/gift-checkouts",
  checkoutStatus: "POST /v1/public/sites/:siteId/gift-checkouts/status",
  finance: "GET /v1/sites/:siteId/finance",
  withdrawalsRead: "GET /v1/sites/:siteId/withdrawals",
  withdrawalCreate: "POST /v1/sites/:siteId/withdrawals",
} as const;

export const asaasWebhookAcceptanceSchema = z
  .object({ accepted: z.literal(true) })
  .strict();

export const giftPurchaseHistoryLimits = Object.freeze({
  indexRows: 25,
  detailFacts: 50,
  jsonBytes: 128 * 1024,
});
const purchaseHistoryMicros = z
  .string()
  .refine(
    (value) =>
      /^(?:0|[1-9][0-9]{0,17})$/.test(value) &&
      BigInt(value) <= 253402300799999999n,
    "Expected canonical supported epoch microseconds",
  );
function purchaseHistoryTimeWithin(
  value: string,
  lower: string,
  upper: string,
) {
  return (
    purchaseHistoryMicros.safeParse(value).success &&
    purchaseHistoryMicros.safeParse(lower).success &&
    purchaseHistoryMicros.safeParse(upper).success &&
    BigInt(value) >= BigInt(lower) &&
    BigInt(value) <= BigInt(upper)
  );
}
function purchaseHistoryJsonFits(value: unknown) {
  return (
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
    giftPurchaseHistoryLimits.jsonBytes
  );
}
const purchaseHistoryCursor = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .nullable();
export const giftPurchaseHistoryScopeSchema = z
  .object({
    siteId: id.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    mode: z.enum(["sandbox", "live"]),
    policy: z.literal("SITE_HISTORY"),
  })
  .strict();
export type GiftPurchaseHistoryScope = z.infer<
  typeof giftPurchaseHistoryScopeSchema
>;

export const giftPurchaseHistoryPurchaseSchema = z
  .object({
    siteId: id.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    mode: z.enum(["sandbox", "live"]),
    orderId: id,
    quoteId: id,
    giftId: id,
    titleSnapshot: z
      .string()
      .min(1)
      .max(120)
      .refine(
        (value) =>
          value === value.trim() &&
          Array.from(value).every((character) => {
            const code = character.charCodeAt(0);
            return code >= 32 && !(code >= 127 && code <= 159);
          }),
      ),
    method: giftPaymentMethodSchema,
    currency: z.literal("BRL"),
    purchasedAtMicros: purchaseHistoryMicros,
    destinationVersion: z.number().int().min(1).max(2147483647),
    policyVersion: id,
    binding: z.enum(["AVAILABLE", "UNBOUND"]),
    quoted: z
      .object({
        nominalCents: giftCentsSchema.refine((value) => value > 0),
        commissionCents: giftCentsSchema,
        processingCents: giftCentsSchema,
        totalCents: giftCentsSchema.refine((value) => value > 0),
      })
      .strict()
      .refine(
        (value) =>
          value.totalCents ===
          value.nominalCents + value.commissionCents + value.processingCents,
        "Original allocation must be conserved without repricing",
      ),
  })
  .strict();
export type GiftPurchaseHistoryPurchase = z.infer<
  typeof giftPurchaseHistoryPurchaseSchema
>;

export const giftPurchaseHistoryPaymentSchema = z
  .object({
    paymentId: id,
    attemptId: id,
    orderId: id,
    currency: z.literal("BRL"),
    recordedState: z.enum([
      "UNKNOWN",
      "PENDING",
      "CONFIRMED",
      "RECEIVED",
      "RESTRICTED",
    ]),
    createdAtMicros: purchaseHistoryMicros,
    observedAtMicros: purchaseHistoryMicros.nullable(),
    grossCents: giftCentsSchema.refine((value) => value > 0).nullable(),
    processingCents: giftCentsSchema.nullable(),
    commissionCents: giftCentsSchema.nullable(),
    recipientNetCents: giftCentsSchema.nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.processingCents === null ||
      value.commissionCents === null ||
      value.recipientNetCents === null ||
      (value.grossCents !== null &&
        value.grossCents ===
          value.processingCents +
            value.commissionCents +
            value.recipientNetCents),
    "Complete actual allocation must match actual gross",
  );
export type GiftPurchaseHistoryPayment = z.infer<
  typeof giftPurchaseHistoryPaymentSchema
>;

// This label validates wire structure; only the stored reader can prove its source chain.
export const giftPurchaseHistoryReceiptSchema = z
  .object({
    effectId: id,
    paymentId: id,
    orderId: id,
    currency: z.literal("BRL"),
    recipientCreditCents: giftCentsSchema.refine((value) => value > 0),
    postedAtMicros: purchaseHistoryMicros,
    sourceObservedAtMicros: purchaseHistoryMicros,
    source: z.literal("CORRELATED_STORED_POSTING"),
  })
  .strict()
  .refine(
    (value) =>
      purchaseHistoryTimeWithin(
        value.sourceObservedAtMicros,
        "0",
        value.postedAtMicros,
      ),
    "Historical source cannot occur after local posting",
  );
export type GiftPurchaseHistoryReceipt = z.infer<
  typeof giftPurchaseHistoryReceiptSchema
>;

const purchaseHistoryEnvelope = {
  scope: giftPurchaseHistoryScopeSchema,
  consistency: z.literal("PER_READ"),
  readObservedAtMicros: purchaseHistoryMicros,
  currentKnowledge: z.enum(["UNKNOWN", "UNAVAILABLE"]),
  sourceOrdering: z.literal("UNAVAILABLE"),
  nextCursor: purchaseHistoryCursor,
};
export const giftPurchaseHistoryPageSchema = z
  .object({
    ...purchaseHistoryEnvelope,
    items: z
      .array(giftPurchaseHistoryPurchaseSchema)
      .max(giftPurchaseHistoryLimits.indexRows),
  })
  .strict()
  .refine((value) => {
    if (
      new Set(value.items.map((item) => item.orderId)).size !==
        value.items.length ||
      new Set(value.items.map((item) => item.quoteId)).size !==
        value.items.length
    )
      return false;
    return value.items.every((item, index) => {
      if (
        item.siteId !== value.scope.siteId ||
        item.mode !== value.scope.mode ||
        !purchaseHistoryTimeWithin(
          item.purchasedAtMicros,
          "0",
          value.readObservedAtMicros,
        )
      )
        return false;
      const previous = value.items[index - 1];
      return (
        !previous ||
        BigInt(item.purchasedAtMicros) < BigInt(previous.purchasedAtMicros) ||
        (item.purchasedAtMicros === previous.purchasedAtMicros &&
          item.orderId < previous.orderId)
      );
    });
  }, "Original index scope, identities, times or navigation order conflict")
  .refine(purchaseHistoryJsonFits, "History JSON exceeds its UTF-8 bound");
export type GiftPurchaseHistoryPage = z.infer<
  typeof giftPurchaseHistoryPageSchema
>;

export const giftPurchaseHistoryDetailPageSchema = z
  .object({
    ...purchaseHistoryEnvelope,
    originalPurchase: giftPurchaseHistoryPurchaseSchema,
    coverage: z
      .object({
        payments: z.enum(["AVAILABLE", "UNAVAILABLE"]),
        receipts: z.enum(["AVAILABLE", "UNAVAILABLE"]),
        reversals: z.literal("UNAVAILABLE"),
        bankSettlement: z.literal("UNAVAILABLE"),
      })
      .strict(),
    retainedPayments: z
      .array(giftPurchaseHistoryPaymentSchema)
      .max(giftPurchaseHistoryLimits.detailFacts),
    validatedHistoricalReceipts: z
      .array(giftPurchaseHistoryReceiptSchema)
      .max(giftPurchaseHistoryLimits.detailFacts),
  })
  .strict()
  .refine((value) => {
    const purchase = value.originalPurchase,
      payments = value.retainedPayments,
      receipts = value.validatedHistoricalReceipts;
    if (
      purchase.siteId !== value.scope.siteId ||
      purchase.mode !== value.scope.mode ||
      !purchaseHistoryTimeWithin(
        purchase.purchasedAtMicros,
        "0",
        value.readObservedAtMicros,
      ) ||
      payments.length + receipts.length >
        giftPurchaseHistoryLimits.detailFacts ||
      new Set(payments.map((payment) => payment.paymentId)).size !==
        payments.length ||
      new Set(receipts.map((receipt) => receipt.effectId)).size !==
        receipts.length ||
      new Set(receipts.map((receipt) => receipt.paymentId)).size !==
        receipts.length ||
      (value.coverage.payments === "UNAVAILABLE" && payments.length > 0) ||
      (value.coverage.receipts === "UNAVAILABLE" && receipts.length > 0) ||
      ((value.coverage.payments === "UNAVAILABLE" ||
        value.coverage.receipts === "UNAVAILABLE") &&
        value.currentKnowledge !== "UNAVAILABLE") ||
      (purchase.binding === "UNBOUND" &&
        (payments.length > 0 ||
          receipts.length > 0 ||
          value.currentKnowledge !== "UNAVAILABLE" ||
          value.coverage.payments !== "UNAVAILABLE" ||
          value.coverage.receipts !== "UNAVAILABLE"))
    )
      return false;
    if (
      payments.some(
        (payment) =>
          payment.orderId !== purchase.orderId ||
          !purchaseHistoryTimeWithin(
            payment.createdAtMicros,
            purchase.purchasedAtMicros,
            value.readObservedAtMicros,
          ) ||
          (payment.observedAtMicros !== null &&
            !purchaseHistoryTimeWithin(
              payment.observedAtMicros,
              purchase.purchasedAtMicros,
              value.readObservedAtMicros,
            )),
      )
    )
      return false;
    return receipts.every((receipt) => {
      if (
        receipt.orderId !== purchase.orderId ||
        receipt.recipientCreditCents !== purchase.quoted.nominalCents ||
        !purchaseHistoryTimeWithin(
          receipt.postedAtMicros,
          purchase.purchasedAtMicros,
          value.readObservedAtMicros,
        ) ||
        !purchaseHistoryTimeWithin(
          receipt.sourceObservedAtMicros,
          purchase.purchasedAtMicros,
          receipt.postedAtMicros,
        )
      )
        return false;
      const payment = payments.find(
        (item) => item.paymentId === receipt.paymentId,
      );
      return (
        !payment ||
        (payment.recordedState === "RECEIVED" &&
          payment.observedAtMicros === receipt.sourceObservedAtMicros &&
          payment.grossCents === purchase.quoted.totalCents &&
          payment.processingCents === purchase.quoted.processingCents &&
          payment.commissionCents === purchase.quoted.commissionCents &&
          payment.recipientNetCents === purchase.quoted.nominalCents)
      );
    });
  }, "Historical detail scope, identities, allocation, coverage or times conflict")
  .refine(purchaseHistoryJsonFits, "History JSON exceeds its UTF-8 bound");
export type GiftPurchaseHistoryDetailPage = z.infer<
  typeof giftPurchaseHistoryDetailPageSchema
>;

export const giftPurchaseHistoryPageResponseSchema = z
  .object({
    history: giftPurchaseHistoryPageSchema,
  })
  .strict()
  .refine(purchaseHistoryJsonFits, "History JSON exceeds its UTF-8 bound");
export type GiftPurchaseHistoryPageResponse = z.infer<
  typeof giftPurchaseHistoryPageResponseSchema
>;
export const giftPurchaseHistoryDetailResponseSchema = z
  .object({
    history: giftPurchaseHistoryDetailPageSchema,
  })
  .strict()
  .refine(purchaseHistoryJsonFits, "History JSON exceeds its UTF-8 bound");
export type GiftPurchaseHistoryDetailResponse = z.infer<
  typeof giftPurchaseHistoryDetailResponseSchema
>;

export const giftCatalogLimits = Object.freeze({
  activeItems: 200,
  activeStates: Object.freeze(["DRAFT", "PUBLISHED"] as const),
  pageSize: 20,
  maxPage: Math.floor(Number.MAX_SAFE_INTEGER / 20) + 1,
  queryBytes: 2048,
  qUnits: 100,
  qBytes: 400,
  imageUrlUnits: 2048,
  jsonBytes: 512 * 1024,
});

function catalogText(max: number, description = false) {
  return z
    .string()
    .max(max)
    .refine((value) => {
      if (/[\ud800-\udfff]/u.test(value)) return false;
      for (const character of value) {
        const code = character.charCodeAt(0);
        if (
          (code < 32 || code === 127) &&
          !(description && (code === 9 || code === 10 || code === 13))
        )
          return false;
      }
      return true;
    }, "Expected bounded well-formed public text");
}

const catalogQueryText = catalogText(giftCatalogLimits.qUnits).refine(
  (value) =>
    new TextEncoder().encode(value).byteLength <= giftCatalogLimits.qBytes,
  "Catalog search exceeds its UTF-8 bound",
);
const catalogPageNumber = z
  .number()
  .int()
  .min(1)
  .max(giftCatalogLimits.maxPage);
export const publicGiftCatalogQuerySchema = z
  .object({
    page: catalogPageNumber.default(1),
    q: catalogQueryText
      .transform((value) => value.trim())
      .pipe(catalogQueryText)
      .default(""),
  })
  .strict();
export type PublicGiftCatalogQuery = z.infer<
  typeof publicGiftCatalogQuerySchema
>;

const catalogPageImageUrl = catalogText(giftCatalogLimits.imageUrlUnits)
  .min(1)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        !value.includes("?") &&
        !value.includes("#")
      );
    } catch {
      return false;
    }
  }, "Expected a public HTTPS image URL");
const catalogPageCard = z
  .object({
    id,
    siteId: id,
    title: catalogText(120).refine((value) => value.trim().length > 0),
    description: catalogText(2000, true),
    nominalCents: giftFields.nominalCents,
    currency: z.literal("BRL"),
    image: z
      .object({ url: catalogPageImageUrl, alt: catalogText(240) })
      .strict()
      .nullable(),
    sortOrder: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const publicGiftCatalogPageResponseSchema = z
  .object({
    siteId: id,
    mode: receivingModeSchema,
    gifts: z.array(catalogPageCard).max(giftCatalogLimits.pageSize),
    page: catalogPageNumber,
    pageSize: z.literal(giftCatalogLimits.pageSize),
    q: catalogQueryText.refine((value) => value === value.trim()),
    total: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    totalPages: catalogPageNumber,
    hasNext: z.boolean(),
  })
  .strict()
  .refine((value) => {
    const offset = giftCatalogLimits.pageSize * (value.page - 1);
    const pages = Math.max(
      1,
      Math.ceil(value.total / giftCatalogLimits.pageSize),
    );
    if (
      value.totalPages !== pages ||
      value.hasNext !== value.page < pages ||
      value.gifts.length !==
        Math.max(
          0,
          Math.min(giftCatalogLimits.pageSize, value.total - offset),
        ) ||
      new Set(value.gifts.map((gift) => gift.id)).size !== value.gifts.length
    )
      return false;
    return value.gifts.every((gift, index) => {
      if (gift.siteId !== value.siteId) return false;
      const previous = value.gifts[index - 1];
      return (
        !previous ||
        previous.sortOrder < gift.sortOrder ||
        (previous.sortOrder === gift.sortOrder && previous.id < gift.id)
      );
    });
  }, "Catalog page scope, count or ordering conflicts")
  // This bounds canonical serialization, not bytes received over a transport.
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      giftCatalogLimits.jsonBytes,
    "Catalog page JSON exceeds its UTF-8 bound",
  );
export type PublicGiftCatalogPageResponse = z.infer<
  typeof publicGiftCatalogPageResponseSchema
>;
