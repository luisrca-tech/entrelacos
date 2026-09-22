import { z } from "zod";

const strictObject = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).strict();

const nonEmptyText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => /\S/.test(value));

const identifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

export const siteIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);

export const repositorySlugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);

const persistedRepositorySlugSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);

export const provisioningKeySchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

export const adminRoleSchema = z.enum(["OWNER", "SITE_ADMIN"]);
export const accountStateSchema = z.enum(["PENDING", "ACTIVE", "DISABLED"]);
export const siteLifecycleSchema = z.enum([
  "DRAFT",
  "IN_REVIEW",
  "ACTIVE",
  "INACTIVE",
]);
export const sitePublicationStateSchema = z.enum([
  "UNPUBLISHED",
  "PUBLISHED",
  "PLACEHOLDER",
]);
export const siteDomainStateSchema = z.enum([
  "NONE",
  "PENDING",
  "ACTIVE",
  "INACTIVE",
]);
export const adminAccessPurposeSchema = z.enum(["ACTIVATION", "RECOVERY"]);

function validCalendarDate(value: string): boolean {
  const parts = value.split("-").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [year, month, day] = parts;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(validCalendarDate, "Invalid calendar date");

export const instantSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
    "Expected an ISO-8601 UTC instant",
  )
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid instant");

function validIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export const ianaTimezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(validIanaTimezone, "Expected a valid IANA timezone");

function parseSafeHttpsUrl(value: string): URL | undefined {
  try {
    const parsed = new URL(value);
    const localHttp =
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "[::1]");
    if (
      (parsed.protocol !== "https:" && !localHttp) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export const publicUrlSchema = z.string().refine((value) => {
  const parsed = parseSafeHttpsUrl(value);
  return parsed !== undefined && parsed.pathname === "/";
}, "Expected a safe HTTPS public URL or local HTTP URL");

export const originSchema = z.string().refine((value) => {
  const parsed = parseSafeHttpsUrl(value);
  return (
    parsed !== undefined && parsed.origin === value && parsed.pathname === "/"
  );
}, "Expected an exact HTTPS origin or local HTTP origin");

export const opaqueTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "Invalid opaque token");

export const emailSchema = z.string().email().max(320);

export const domainNameSchema = z.string().refine((value) => {
  if (value.length > 253 || value !== value.toLowerCase()) return false;
  try {
    const parsed = new URL(`https://${value}`);
    return parsed.hostname === value && parsed.pathname === "/";
  } catch {
    return false;
  }
}, "Expected a lowercase domain name");

export const healthResponseSchema = strictObject({
  status: z.literal("ok"),
  service: z.literal("entrelacos-api"),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const apiProblemSchema = strictObject({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
});

export type ApiProblem = z.infer<typeof apiProblemSchema>;

const coupleNamesSchema = z
  .array(nonEmptyText(120))
  .length(2, "Exactly two couple names are required");

const lifecycleFields = {
  lifecycle: siteLifecycleSchema,
  previousLifecycle: siteLifecycleSchema.nullable(),
};

export const siteRecordSchema = strictObject({
  id: siteIdSchema,
  repositorySlug: persistedRepositorySlugSchema,
  provisioningKey: provisioningKeySchema,
  displayName: nonEmptyText(160),
  coupleNames: coupleNamesSchema,
  eventDate: calendarDateSchema,
  ...lifecycleFields,
  publicationState: sitePublicationStateSchema,
  isDemo: z.boolean().default(false),
  publicUrl: publicUrlSchema.nullable(),
  trustedOrigins: z.array(originSchema).max(20),
  reviewApprovedAt: instantSchema.nullable(),
  termStartsOn: calendarDateSchema.nullable(),
  termEndsOn: calendarDateSchema.nullable(),
  rsvpDeadlineAt: instantSchema.nullable(),
  rsvpDeadlineTimezone: ianaTimezoneSchema.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
}).superRefine((value, context) => {
  if (value.lifecycle === "INACTIVE" && value.previousLifecycle === null) {
    context.addIssue({
      code: "custom",
      path: ["previousLifecycle"],
      message: "Inactive sites retain their previous non-inactive lifecycle",
    });
  }
  if (value.previousLifecycle === "INACTIVE") {
    context.addIssue({
      code: "custom",
      path: ["previousLifecycle"],
      message: "Previous lifecycle must not be INACTIVE",
    });
  }
  if (
    value.termStartsOn &&
    value.termEndsOn &&
    value.termEndsOn < value.termStartsOn
  ) {
    context.addIssue({
      code: "custom",
      path: ["termEndsOn"],
      message: "Term end must be on or after term start",
    });
  }
  if (
    (value.rsvpDeadlineAt === null) !==
    (value.rsvpDeadlineTimezone === null)
  ) {
    context.addIssue({
      code: "custom",
      path: [
        value.rsvpDeadlineAt === null
          ? "rsvpDeadlineTimezone"
          : "rsvpDeadlineAt",
      ],
      message: "RSVP deadline instant and timezone must be set together",
    });
  }
});

export type SiteRecord = z.infer<typeof siteRecordSchema>;

export const ownerSiteCreateInputSchema = strictObject({
  repositorySlug: repositorySlugSchema,
  provisioningKey: provisioningKeySchema,
  displayName: nonEmptyText(160),
  coupleNames: coupleNamesSchema,
  eventDate: calendarDateSchema,
});
export type OwnerSiteCreateInput = z.infer<typeof ownerSiteCreateInputSchema>;

export const ownerSiteResumeInputSchema = strictObject({
  provisioningKey: provisioningKeySchema,
});
export type OwnerSiteResumeInput = z.infer<typeof ownerSiteResumeInputSchema>;

export const siteUpdateInputSchema = strictObject({
  displayName: nonEmptyText(160).optional(),
  coupleNames: coupleNamesSchema.optional(),
  eventDate: calendarDateSchema.optional(),
  publicUrl: publicUrlSchema.nullable().optional(),
  trustedOrigins: z.array(originSchema).max(20).optional(),
  publicationState: sitePublicationStateSchema.optional(),
}).superRefine((value, context) => {
  if (Object.keys(value).length === 0) {
    context.addIssue({
      code: "custom",
      message: "At least one field is required",
    });
  }
});
export type SiteUpdateInput = z.infer<typeof siteUpdateInputSchema>;

export const dateEditInputSchema = strictObject({
  eventDate: calendarDateSchema.optional(),
  termStartsOn: calendarDateSchema.nullable().optional(),
  termEndsOn: calendarDateSchema.nullable().optional(),
}).superRefine((value, context) => {
  if (Object.keys(value).length === 0) {
    context.addIssue({
      code: "custom",
      message: "At least one date is required",
    });
  }
  if (
    value.termStartsOn &&
    value.termEndsOn &&
    value.termEndsOn < value.termStartsOn
  ) {
    context.addIssue({
      code: "custom",
      path: ["termEndsOn"],
      message: "Term end must be on or after term start",
    });
  }
});
export type DateEditInput = z.infer<typeof dateEditInputSchema>;

export const siteReviewApproveInputSchema = strictObject({});
export type SiteReviewApproveInput = z.infer<
  typeof siteReviewApproveInputSchema
>;

export const emptyMutationInputSchema = strictObject({});
export const siteStartReviewInputSchema = emptyMutationInputSchema;
export const sitePublicationUpdateInputSchema = strictObject({
  publicationState: sitePublicationStateSchema,
});

const ownerSiteResponseShape = { site: siteRecordSchema };
export const ownerSiteResponseSchema = strictObject(ownerSiteResponseShape);
export const ownerSiteCreateResponseSchema = ownerSiteResponseSchema;
export const ownerSiteResumeResponseSchema = ownerSiteResponseSchema;
export const ownerSiteUpdateResponseSchema = ownerSiteResponseSchema;
export const ownerSiteLifecycleResponseSchema = ownerSiteResponseSchema;

export const ownerSiteListQuerySchema = strictObject({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const ownerSiteListResponseSchema = strictObject({
  sites: z.array(siteRecordSchema),
  nextCursor: z.string().min(1).max(200).nullable(),
});

export const siteScopedRecordSchema = strictObject({
  id: siteIdSchema,
  displayName: nonEmptyText(160),
  coupleNames: coupleNamesSchema,
  eventDate: calendarDateSchema,
  ...lifecycleFields,
  publicationState: sitePublicationStateSchema,
  isDemo: z.boolean().default(false),
  publicUrl: publicUrlSchema.nullable(),
  termStartsOn: calendarDateSchema.nullable(),
  termEndsOn: calendarDateSchema.nullable(),
  rsvpDeadlineAt: instantSchema.nullable(),
  rsvpDeadlineTimezone: ianaTimezoneSchema.nullable(),
});

export const siteScopedReadResponseSchema = strictObject({
  site: siteScopedRecordSchema,
});

export const siteDomainRecordSchema = strictObject({
  id: identifierSchema,
  siteId: siteIdSchema,
  hostname: domainNameSchema,
  state: siteDomainStateSchema,
  isPrimary: z.boolean(),
  verifiedAt: instantSchema.nullable(),
  expiresOn: calendarDateSchema.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});

export const siteDomainCreateInputSchema = strictObject({
  hostname: domainNameSchema,
  isPrimary: z.boolean().default(false),
  expiresOn: calendarDateSchema.nullable().optional(),
});

export const siteDomainUpdateInputSchema = strictObject({
  state: siteDomainStateSchema.optional(),
  isPrimary: z.boolean().optional(),
  expiresOn: calendarDateSchema.nullable().optional(),
}).superRefine((value, context) => {
  if (Object.keys(value).length === 0) {
    context.addIssue({
      code: "custom",
      message: "At least one domain field is required",
    });
  }
});

export const siteDomainListResponseSchema = strictObject({
  domains: z.array(siteDomainRecordSchema),
});

export const adminCreateInputSchema = strictObject({
  siteId: siteIdSchema,
  name: nonEmptyText(160),
  email: emailSchema,
});
export type AdminCreateInput = z.infer<typeof adminCreateInputSchema>;

export const ownerAdminCreateInputSchema = strictObject({
  name: nonEmptyText(160),
  email: emailSchema,
});

export const adminSummarySchema = strictObject({
  userId: identifierSchema,
  siteId: siteIdSchema,
  name: nonEmptyText(160),
  email: emailSchema,
  role: z.literal("SITE_ADMIN"),
  state: accountStateSchema,
});

export const adminListResponseSchema = strictObject({
  admins: z.array(adminSummarySchema),
});

export const adminAccessIssueInputSchema = strictObject({
  userId: identifierSchema,
  purpose: adminAccessPurposeSchema,
});
export type AdminAccessIssueInput = z.infer<typeof adminAccessIssueInputSchema>;

export const ownerActivationIssueInputSchema = strictObject({
  userId: identifierSchema,
  purpose: z.literal("ACTIVATION"),
});

export const ownerRecoveryIssueInputSchema = strictObject({
  userId: identifierSchema,
  purpose: z.literal("RECOVERY"),
});

export const adminAccessIssueResponseSchema = strictObject({
  userId: identifierSchema,
  siteId: siteIdSchema,
  purpose: adminAccessPurposeSchema,
  token: opaqueTokenSchema,
  expiresAt: instantSchema,
});

export const adminAccessRevokeInputSchema = strictObject({
  userId: identifierSchema,
  purpose: adminAccessPurposeSchema,
});

export const adminDisableInputSchema = strictObject({
  userId: identifierSchema,
});

export const adminMutationResponseSchema = strictObject({
  ok: z.literal(true),
});

export const publicAccessConsumeInputSchema = strictObject({
  token: opaqueTokenSchema,
  password: z.string().min(10).max(12),
});
export type PublicAccessConsumeInput = z.infer<
  typeof publicAccessConsumeInputSchema
>;

export const publicAccessConsumeResponseSchema = strictObject({
  userId: identifierSchema,
  siteId: siteIdSchema,
  email: emailSchema,
  purpose: adminAccessPurposeSchema,
  requiresExplicitLogin: z.literal(true),
});

export const safeActorSchema = strictObject({
  user: strictObject({
    id: identifierSchema,
    name: nonEmptyText(160),
    email: emailSchema,
    role: adminRoleSchema,
  }),
  session: strictObject({
    id: identifierSchema,
    expiresAt: instantSchema,
  }),
  siteId: siteIdSchema.nullable().optional(),
});

export const meResponseSchema = safeActorSchema;
export type MeResponse = z.infer<typeof meResponseSchema>;

export const handoffIssueInputSchema = strictObject({
  siteId: siteIdSchema,
  origin: originSchema,
  challenge: z.string().regex(/^[a-f0-9]{64}$/),
});

export const handoffRedeemInputSchema = strictObject({
  code: opaqueTokenSchema,
  siteId: siteIdSchema,
  origin: originSchema,
  verifier: opaqueTokenSchema,
});

export const handoffRecognitionInputSchema = strictObject({
  recognitionToken: opaqueTokenSchema,
  siteId: siteIdSchema,
  origin: originSchema,
});

export const handoffIssueResponseSchema = strictObject({
  code: opaqueTokenSchema,
  expiresAt: instantSchema,
});

export const handoffRedeemResponseSchema = strictObject({
  recognitionToken: opaqueTokenSchema,
  expiresAt: instantSchema,
});

export const handoffResponseSchema = handoffRedeemResponseSchema;

export const handoffRecognitionResponseSchema = strictObject({
  recognized: z.boolean(),
});

export const block2EndpointPaths = {
  ownerSitesList: "GET /v1/owner/sites",
  ownerSitesCreate: "POST /v1/owner/sites",
  ownerSitesResume: "POST /v1/owner/sites/resume",
  ownerSiteGet: "GET /v1/owner/sites/:siteId",
  ownerSiteUpdate: "PATCH /v1/owner/sites/:siteId",
  ownerSiteApproveReview: "POST /v1/owner/sites/:siteId/review/approve",
  ownerSiteStartReview: "POST /v1/owner/sites/:siteId/review/start",
  ownerSiteUpdatePublication: "PATCH /v1/owner/sites/:siteId/publication",
  ownerSiteDeactivate: "POST /v1/owner/sites/:siteId/deactivate",
  ownerSiteReactivate: "POST /v1/owner/sites/:siteId/reactivate",
  ownerSiteEditDates: "PATCH /v1/owner/sites/:siteId/dates",
  siteScopedRead: "GET /v1/sites/:siteId",
  ownerAdminsCreate: "POST /v1/owner/sites/:siteId/admins",
  ownerAdminsList: "GET /v1/owner/sites/:siteId/admins",
  ownerAdminIssueAccess: "POST /v1/owner/admins/:userId/access",
  ownerAdminRevokeAccess: "POST /v1/owner/admins/:userId/access/revoke",
  ownerAdminDisable: "POST /v1/owner/admins/:userId/disable",
  ownerSiteDomainsCreate: "POST /v1/owner/sites/:siteId/domains",
  ownerSiteDomainsList: "GET /v1/owner/sites/:siteId/domains",
  ownerSiteDomainUpdate: "PATCH /v1/owner/sites/:siteId/domains/:domainId",
  publicActivationConsume: "POST /v1/auth/activation/consume",
  publicRecoveryConsume: "POST /v1/auth/recovery/consume",
  me: "GET /v1/me",
  handoffIssue: "POST /v1/handoff",
  handoffRedeem: "POST /v1/handoff/redeem",
  handoffRecognize: "POST /v1/handoff/recognize",
} as const;

export type Block2EndpointPath =
  (typeof block2EndpointPaths)[keyof typeof block2EndpointPaths];

export const brazilianPhoneE164Schema = z
  .string()
  .regex(/^\+55[1-9]{2}9\d{8}$/, "Expected a Brazilian mobile E.164 phone");

export const brazilianPhoneInputSchema = z
  .string()
  .min(1)
  .max(40)
  .transform((value) => {
    const digits = value.replace(/\D/g, "");
    if (digits.length === 11) return `+55${digits}`;
    if (digits.length === 13 && digits.startsWith("55")) return `+${digits}`;
    return value;
  })
  .pipe(brazilianPhoneE164Schema);

export const guestMemberInputSchema = strictObject({
  id: identifierSchema.optional(),
  fullName: nonEmptyText(160),
  isRepresentative: z.boolean(),
});

const guestMembersWithRepresentativeSchema = z
  .array(guestMemberInputSchema)
  .min(1, "At least one group member is required")
  .superRefine((members, context) => {
    const representatives = members.filter((member) => member.isRepresentative);
    if (representatives.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "Exactly one group representative is required",
      });
    }
  });

export const guestGroupCreateInputSchema = strictObject({
  name: nonEmptyText(160),
  isIndividual: z.boolean().default(false),
  isForeign: z.boolean(),
  phone: brazilianPhoneInputSchema.nullable(),
  members: guestMembersWithRepresentativeSchema,
}).superRefine((value, context) => {
  if (value.isForeign !== (value.phone === null)) {
    context.addIssue({
      code: "custom",
      path: ["phone"],
      message: "Foreign groups omit phone; Brazilian groups require one",
    });
  }
  if (value.isIndividual && value.members.length !== 1) {
    context.addIssue({
      code: "custom",
      path: ["members"],
      message: "Individual invitations require exactly one member",
    });
  }
});
export type GuestGroupCreateInput = z.infer<typeof guestGroupCreateInputSchema>;

export const guestGroupUpdateInputSchema = strictObject({
  name: nonEmptyText(160).optional(),
  isForeign: z.boolean().optional(),
  phone: brazilianPhoneInputSchema.nullable().optional(),
  members: guestMembersWithRepresentativeSchema.optional(),
}).superRefine((value, context) => {
  if (Object.keys(value).length === 0) {
    context.addIssue({
      code: "custom",
      message: "At least one group field is required",
    });
  }
  if (
    value.isForeign === true &&
    value.phone !== undefined &&
    value.phone !== null
  ) {
    context.addIssue({
      code: "custom",
      path: ["phone"],
      message: "Foreign groups omit phone",
    });
  }
  if (value.isForeign === false && value.phone === null) {
    context.addIssue({
      code: "custom",
      path: ["phone"],
      message: "Brazilian groups require phone",
    });
  }
});
export type GuestGroupUpdateInput = z.infer<typeof guestGroupUpdateInputSchema>;

export const guestMemberRecordSchema = strictObject({
  id: identifierSchema,
  fullName: nonEmptyText(160),
  isRepresentative: z.boolean(),
});

const guestMemberRecordsWithRepresentativeSchema = z
  .array(guestMemberRecordSchema)
  .min(1, "At least one group member is required")
  .superRefine((members, context) => {
    if (members.filter((member) => member.isRepresentative).length !== 1) {
      context.addIssue({
        code: "custom",
        message: "Exactly one group representative is required",
      });
    }
  });

export const guestGroupRecordSchema = strictObject({
  id: identifierSchema,
  siteId: siteIdSchema,
  name: nonEmptyText(160),
  isIndividual: z.boolean(),
  isForeign: z.boolean(),
  phone: brazilianPhoneE164Schema.nullable(),
  members: guestMemberRecordsWithRepresentativeSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type GuestGroupRecord = z.infer<typeof guestGroupRecordSchema>;

export const guestGroupResponseSchema = strictObject({
  group: guestGroupRecordSchema,
});

export const guestGroupListResponseSchema = strictObject({
  groups: z.array(guestGroupRecordSchema),
});

export const guestGroupDeleteResponseSchema = adminMutationResponseSchema;

export const guestLookupInputSchema = strictObject({
  fullName: nonEmptyText(160),
  phone: brazilianPhoneInputSchema,
});
export type GuestLookupInput = z.infer<typeof guestLookupInputSchema>;

export const demoGuestGrantSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)
  .max(512);
export const demoGuestGrantIssueInputSchema = strictObject({
  phone: brazilianPhoneInputSchema,
});
export const demoGuestGrantResponseSchema = strictObject({
  grant: demoGuestGrantSchema,
  expiresAt: instantSchema,
});
export type DemoGuestGrantResponse = z.infer<
  typeof demoGuestGrantResponseSchema
>;

export const guestChallengeIdSchema = opaqueTokenSchema;
export const guestAccessPinSchema = z
  .string()
  .regex(/^\d{6}$/, "Expected a six-digit verification code");
export const guestVerificationCodeSchema = guestAccessPinSchema;
export const guestAccessPinResponseSchema = strictObject({
  accessPin: guestAccessPinSchema,
});
export type GuestAccessPinResponse = z.infer<
  typeof guestAccessPinResponseSchema
>;
export const guestVerificationModeSchema = z.enum(["MANUAL", "MOCK", "TWILIO"]);
export const guestDeliveryModeSchema = z.enum([
  "MANUAL_PIN",
  "SIMULATED",
  "REAL_SMS",
]);
export const guestVerificationChallengeStatusSchema = z.enum([
  "PENDING",
  "VERIFIED",
  "EXPIRED",
  "LOCKED",
  "REVOKED",
]);
export const guestVerificationSendStatusSchema = z.enum([
  "MANUAL",
  "RESERVED",
  "PROVIDER_ACCEPTED",
  "FAILED_FINAL",
  "UNKNOWN",
]);

export const guestChallengeStartResponseSchema = strictObject({
  challengeId: guestChallengeIdSchema,
  expiresAt: instantSchema,
  resendAvailableAt: instantSchema,
  sendStatus: guestVerificationSendStatusSchema,
  deliveryMode: guestDeliveryModeSchema,
  simulationCode: guestVerificationCodeSchema.optional(),
}).superRefine((value, context) => {
  if (value.deliveryMode === "REAL_SMS" && value.simulationCode !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["simulationCode"],
      message: "Simulation code is not available for real SMS",
    });
  }
});
export type GuestChallengeStartResponse = z.infer<
  typeof guestChallengeStartResponseSchema
>;

export const guestChallengeResendInputSchema = strictObject({
  challengeId: guestChallengeIdSchema,
});

export const guestChallengeResendResponseSchema =
  guestChallengeStartResponseSchema;

export const guestChallengeVerifyInputSchema = strictObject({
  challengeId: guestChallengeIdSchema,
  code: guestVerificationCodeSchema,
});
export type GuestChallengeVerifyInput = z.infer<
  typeof guestChallengeVerifyInputSchema
>;

export const familyMemberRecordSchema = guestMemberRecordSchema;
export const familySessionResponseSchema = strictObject({
  sessionToken: opaqueTokenSchema,
  siteId: siteIdSchema,
  groupId: identifierSchema,
  members: z.array(familyMemberRecordSchema).min(1),
  expiresAt: instantSchema,
});
export type FamilySessionResponse = z.infer<typeof familySessionResponseSchema>;

export const familySessionReadResponseSchema = strictObject({
  siteId: siteIdSchema,
  groupId: identifierSchema,
  members: z.array(familyMemberRecordSchema).min(1),
  expiresAt: instantSchema,
});
export type FamilySessionReadResponse = z.infer<
  typeof familySessionReadResponseSchema
>;

export const familySessionLeaveResponseSchema = adminMutationResponseSchema;

export const rsvpStateSchema = z.enum(["PENDING", "CONFIRMED", "DECLINED"]);
export type RsvpState = z.infer<typeof rsvpStateSchema>;

export const rsvpActorTypeSchema = z.enum(["ADMIN", "FAMILY"]);
export type RsvpActorType = z.infer<typeof rsvpActorTypeSchema>;

export const rsvpDeadlineSchema = strictObject({
  deadlineAt: instantSchema.nullable(),
  deadlineTimezone: ianaTimezoneSchema.nullable(),
}).superRefine((value, context) => {
  if ((value.deadlineAt === null) !== (value.deadlineTimezone === null)) {
    context.addIssue({
      code: "custom",
      path: [value.deadlineAt === null ? "deadlineTimezone" : "deadlineAt"],
      message: "RSVP deadline instant and timezone must be set together",
    });
  }
});
export type RsvpDeadline = z.infer<typeof rsvpDeadlineSchema>;

export const rsvpMemberRecordSchema = strictObject({
  id: identifierSchema,
  fullName: nonEmptyText(160),
  isRepresentative: z.boolean(),
  state: rsvpStateSchema,
  revision: z.number().int().nonnegative(),
});
export type RsvpMemberRecord = z.infer<typeof rsvpMemberRecordSchema>;

const rsvpMemberUpdateSchema = strictObject({
  memberId: identifierSchema,
  state: rsvpStateSchema,
  expectedRevision: z.number().int().nonnegative(),
});
export type RsvpMemberUpdate = z.infer<typeof rsvpMemberUpdateSchema>;

function uniqueMemberUpdates<T extends z.ZodTypeAny>(schema: T) {
  return strictObject({
    requestId: z.string().uuid(),
    members: z.array(schema).min(1).max(500),
  }).superRefine((value, context) => {
    const ids = new Set<string>();
    for (const member of value.members as Array<{ memberId: string }>) {
      if (ids.has(member.memberId)) {
        context.addIssue({
          code: "custom",
          path: ["members"],
          message: "RSVP member updates must be unique",
        });
      }
      ids.add(member.memberId);
    }
  });
}

export const familyRsvpWriteInputSchema = uniqueMemberUpdates(
  rsvpMemberUpdateSchema,
);
export const adminRsvpWriteInputSchema = familyRsvpWriteInputSchema;
export type FamilyRsvpWriteInput = z.infer<typeof familyRsvpWriteInputSchema>;
export type AdminRsvpWriteInput = z.infer<typeof adminRsvpWriteInputSchema>;

export const familyRsvpResponseSchema = strictObject({
  siteId: siteIdSchema,
  groupId: identifierSchema,
  deadlineAt: instantSchema.nullable(),
  deadlineTimezone: ianaTimezoneSchema.nullable(),
  serverNow: instantSchema,
  canEdit: z.boolean(),
  readOnlyReason: z.enum(["DEADLINE_PASSED"]).nullable(),
  members: z.array(rsvpMemberRecordSchema).min(1),
});
export type FamilyRsvpResponse = z.infer<typeof familyRsvpResponseSchema>;

export const rsvpWriteResponseSchema = strictObject({
  requestId: z.string().uuid(),
  acceptedAt: instantSchema,
  result: z.enum(["APPLIED", "NO_CHANGE"]),
  replayed: z.boolean(),
  members: z.array(rsvpMemberRecordSchema).min(1),
});
export type RsvpWriteResponse = z.infer<typeof rsvpWriteResponseSchema>;

export const rsvpTotalsSchema = strictObject({
  pending: z.number().int().nonnegative(),
  confirmed: z.number().int().nonnegative(),
  declined: z.number().int().nonnegative(),
});

export const rsvpGroupRecordSchema = strictObject({
  id: identifierSchema,
  name: nonEmptyText(160),
  members: z.array(rsvpMemberRecordSchema),
  totals: rsvpTotalsSchema,
});

export const siteRsvpQuerySchema = strictObject({
  groupId: identifierSchema.optional(),
  state: rsvpStateSchema.optional(),
});

export const siteRsvpResponseSchema = strictObject({
  siteId: siteIdSchema,
  lifecycle: z.enum(["DRAFT", "IN_REVIEW", "ACTIVE", "INACTIVE"]),
  deadlineAt: instantSchema.nullable(),
  deadlineTimezone: ianaTimezoneSchema.nullable(),
  totals: rsvpTotalsSchema,
  groups: z.array(rsvpGroupRecordSchema),
});
export type SiteRsvpResponse = z.infer<typeof siteRsvpResponseSchema>;

export const rsvpHistoryQuerySchema = strictObject({
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  groupId: identifierSchema.optional(),
  memberId: identifierSchema.optional(),
  actorType: rsvpActorTypeSchema.optional(),
  beforeState: rsvpStateSchema.optional(),
  afterState: rsvpStateSchema.optional(),
  from: instantSchema.optional(),
  to: instantSchema.optional(),
});
export type RsvpHistoryQuery = z.infer<typeof rsvpHistoryQuerySchema>;

export const rsvpHistoryEntrySchema = strictObject({
  id: identifierSchema,
  siteId: siteIdSchema,
  groupId: identifierSchema,
  groupName: nonEmptyText(160),
  memberId: identifierSchema,
  memberDisplayName: nonEmptyText(160),
  beforeState: rsvpStateSchema,
  afterState: rsvpStateSchema,
  actorType: rsvpActorTypeSchema,
  actorId: identifierSchema,
  actorDisplayName: nonEmptyText(160),
  occurredAt: instantSchema,
});

export const rsvpHistoryResponseSchema = strictObject({
  entries: z.array(rsvpHistoryEntrySchema),
  nextCursor: z.string().min(1).max(500).nullable(),
});
export type RsvpHistoryResponse = z.infer<typeof rsvpHistoryResponseSchema>;

export const rsvpErrorCodeSchema = z.enum([
  "RSVP_CONFLICT",
  "RSVP_DEADLINE_PASSED",
  "IDEMPOTENCY_KEY_REUSED",
]);

export const block4EndpointPaths = {
  publicFamilyRsvpRead: "GET /v1/public/family/rsvp",
  publicFamilyRsvpWrite: "POST /v1/public/family/rsvp",
  siteRsvpRead: "GET /v1/sites/:siteId/rsvp",
  siteRsvpWrite: "POST /v1/sites/:siteId/rsvp",
  siteRsvpDeadlineRead: "GET /v1/sites/:siteId/rsvp/deadline",
  siteRsvpDeadlineUpdate: "PATCH /v1/sites/:siteId/rsvp/deadline",
  siteRsvpHistoryRead: "GET /v1/sites/:siteId/rsvp/history",
} as const;

export const block3EndpointPaths = {
  siteGroupsList: "GET /v1/sites/:siteId/groups",
  siteGroupsCreate: "POST /v1/sites/:siteId/groups",
  siteGroupUpdate: "PATCH /v1/sites/:siteId/groups/:groupId",
  siteGroupDelete: "DELETE /v1/sites/:siteId/groups/:groupId",
  siteGroupAccessPin: "GET /v1/sites/:siteId/groups/:groupId/access-pin",
  siteGroupAccessPinRotate:
    "POST /v1/sites/:siteId/groups/:groupId/access-pin/rotate",
  publicGuestChallengeStart: "POST /v1/public/sites/:siteId/guest/challenge",
  demoGuestGrant: "POST /v1/owner/sites/:siteId/demo/guest-grant",
  publicGuestChallengeResend:
    "POST /v1/public/guest/challenge/:challengeId/resend",
  publicGuestChallengeVerify:
    "POST /v1/public/guest/challenge/:challengeId/verify",
  publicFamilySession: "GET /v1/public/family/session",
  publicFamilySessionLeave: "POST /v1/public/family/session/leave",
} as const;

export type Block3EndpointPath =
  (typeof block3EndpointPaths)[keyof typeof block3EndpointPaths];

function validMessageText(value: string): boolean {
  if (!/\S/u.test(value) || value.includes("<") || value.includes(">")) {
    return false;
  }
  if (Array.from(value).length > 1_000) return false;
  return Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint === 10 ||
      (codePoint > 31 && !(codePoint >= 127 && codePoint <= 159))
    );
  });
}

export const messageTextSchema = z
  .string()
  .transform((value) => value.replace(/\r\n?/g, "\n"))
  .refine(validMessageText, "Expected 1-1000 plain-text Unicode code points");

export const familyMessageReadOnlyReasonSchema = z.enum([
  "MURAL_DISABLED",
  "MESSAGE_BLOCKED",
]);

export const familyMessageRecordSchema = strictObject({
  id: identifierSchema,
  authorName: nonEmptyText(160),
  groupName: nonEmptyText(160),
  text: messageTextSchema,
  revision: z.number().int().positive(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type FamilyMessageRecord = z.infer<typeof familyMessageRecordSchema>;

export const messageMutationInputSchema = strictObject({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  text: messageTextSchema,
});
export type MessageMutationInput = z.infer<typeof messageMutationInputSchema>;

export const messageMutationResponseSchema = strictObject({
  requestId: z.string().uuid(),
  acceptedAt: instantSchema,
  result: z.enum(["APPLIED", "NO_CHANGE"]),
  replayed: z.boolean(),
  message: familyMessageRecordSchema,
});
export type MessageMutationResponse = z.infer<
  typeof messageMutationResponseSchema
>;

export const familyMessageResponseSchema = strictObject({
  siteId: siteIdSchema,
  groupId: identifierSchema,
  currentRevision: z.number().int().nonnegative(),
  canEdit: z.boolean(),
  readOnlyReason: familyMessageReadOnlyReasonSchema.nullable(),
  message: familyMessageRecordSchema.nullable(),
});
export type FamilyMessageResponse = z.infer<typeof familyMessageResponseSchema>;

export const publicMuralQuerySchema = strictObject({
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PublicMuralQuery = z.infer<typeof publicMuralQuerySchema>;

export const publicMuralResponseSchema = strictObject({
  enabled: z.boolean(),
  messages: z.array(
    strictObject({
      id: identifierSchema,
      authorName: nonEmptyText(160),
      groupName: nonEmptyText(160),
      text: messageTextSchema,
      createdAt: instantSchema,
      updatedAt: instantSchema,
    }),
  ),
  nextCursor: z.string().min(1).max(500).nullable(),
}).superRefine((value, context) => {
  if (
    !value.enabled &&
    (value.messages.length > 0 || value.nextCursor !== null)
  ) {
    context.addIssue({
      code: "custom",
      message: "A disabled mural cannot expose stored messages",
    });
  }
});
export type PublicMuralResponse = z.infer<typeof publicMuralResponseSchema>;

export const siteMessagesQuerySchema = strictObject({
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  groupId: identifierSchema.optional(),
});

export const siteMessageRecordSchema = strictObject({
  groupId: identifierSchema,
  groupName: nonEmptyText(160),
  blocked: z.boolean(),
  currentRevision: z.number().int().nonnegative(),
  message: familyMessageRecordSchema.nullable(),
});
export type SiteMessageRecord = z.infer<typeof siteMessageRecordSchema>;

export const siteMessagesResponseSchema = strictObject({
  groups: z.array(siteMessageRecordSchema),
  nextCursor: z.string().min(1).max(500).nullable(),
});

export const muralConfigurationSchema = strictObject({ enabled: z.boolean() });
export type MuralConfiguration = z.infer<typeof muralConfigurationSchema>;

export const muralConfigurationResponseSchema = strictObject({
  siteId: siteIdSchema,
  enabled: z.boolean(),
});

export const siteMessageBlockInputSchema = strictObject({
  blocked: z.boolean(),
});
export const siteMessageBlockResponseSchema = strictObject({
  groupId: identifierSchema,
  blocked: z.boolean(),
});

export const messageDeletionInputSchema = strictObject({
  expectedRevision: z.number().int().positive(),
});
export const messageDeletionResponseSchema = strictObject({
  ok: z.literal(true),
  currentRevision: z.number().int().nonnegative(),
});

export const groupDeleteConfirmationSchema = strictObject({
  confirmGroupId: identifierSchema,
  confirmGroupName: nonEmptyText(160),
});
export type GroupDeleteConfirmation = z.infer<
  typeof groupDeleteConfirmationSchema
>;

const explicitBooleanQuerySchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

export const rsvpExportQuerySchema = strictObject({
  requestId: z.string().uuid(),
  includePhone: explicitBooleanQuerySchema,
  groupId: identifierSchema.optional(),
  state: rsvpStateSchema.optional(),
});
export type RsvpExportQuery = z.infer<typeof rsvpExportQuerySchema>;

export const smsQuotaInputSchema = strictObject({
  monthlyLimit: z.number().int().min(0).max(1_000_000),
});
export type SmsQuotaInput = z.infer<typeof smsQuotaInputSchema>;

export const smsQuotaResponseSchema = strictObject({
  siteId: siteIdSchema,
  monthlyLimit: z.number().int().min(0).max(1_000_000),
});

export const smsUsageAlertSchema = z.enum([
  "NOT_CONFIGURED",
  "BELOW_80",
  "AT_OR_ABOVE_80",
  "AT_OR_ABOVE_100",
]);

export const smsUsageCountersSchema = strictObject({
  reserved: z.number().int().nonnegative(),
  providerAccepted: z.number().int().nonnegative(),
  failedFinal: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  consumed: z.number().int().nonnegative(),
}).superRefine((value, context) => {
  if (
    value.consumed !==
    value.reserved + value.providerAccepted + value.failedFinal + value.unknown
  ) {
    context.addIssue({
      code: "custom",
      path: ["consumed"],
      message: "Consumed SMS usage must equal all reserved outcomes",
    });
  }
});

export const smsUsageResponseSchema = strictObject({
  siteId: siteIdSchema,
  timezone: z.literal("America/Sao_Paulo"),
  periodStart: instantSchema,
  periodEnd: instantSchema,
  monthlyLimit: z.number().int().min(0).max(1_000_000).nullable(),
  alert: smsUsageAlertSchema,
  realSms: smsUsageCountersSchema,
  simulated: smsUsageCountersSchema,
});
export type SmsUsageResponse = z.infer<typeof smsUsageResponseSchema>;

export const block5ErrorCodeSchema = z.enum([
  "MURAL_DISABLED",
  "MESSAGE_BLOCKED",
  "MESSAGE_CONFLICT",
  "MESSAGE_REMOVED",
  "MESSAGE_NOT_FOUND",
  "GROUP_CONFIRMATION_MISMATCH",
  "RSVP_RESULT_REMOVED",
  "SMS_QUOTA_NOT_CONFIGURED",
  "SMS_QUOTA_EXCEEDED",
]);

export const block5EndpointPaths = {
  publicFamilyMessageRead: "GET /v1/public/family/message",
  publicFamilyMessageWrite: "PUT /v1/public/family/message",
  publicMuralRead: "GET /v1/public/sites/:siteId/mural",
  siteMessagesRead: "GET /v1/sites/:siteId/messages",
  siteMuralRead: "GET /v1/sites/:siteId/mural",
  siteMuralUpdate: "PATCH /v1/sites/:siteId/mural",
  siteMessageDelete: "DELETE /v1/sites/:siteId/groups/:groupId/message",
  siteMessageBlockUpdate:
    "PATCH /v1/sites/:siteId/groups/:groupId/message-block",
  siteGroupDelete: "DELETE /v1/sites/:siteId/groups/:groupId",
  siteRsvpCsvExport: "GET /v1/sites/:siteId/reports/rsvp.csv",
  siteRsvpPdfExport: "GET /v1/sites/:siteId/reports/rsvp.pdf",
  siteSmsUsageRead: "GET /v1/sites/:siteId/sms-usage",
  ownerSiteSmsQuotaUpdate: "PATCH /v1/owner/sites/:siteId/sms-quota",
} as const;

export type Block5EndpointPath =
  (typeof block5EndpointPaths)[keyof typeof block5EndpointPaths];

export const demoResetDatasetVersionSchema = z.literal("block7-demo-v1");
export const demoResetInputSchema = strictObject({
  datasetVersion: demoResetDatasetVersionSchema,
});
export type DemoResetInput = z.infer<typeof demoResetInputSchema>;

export const demoResetResponseSchema = strictObject({
  siteId: siteIdSchema,
  datasetVersion: demoResetDatasetVersionSchema,
  result: z.literal("RESET"),
  resetAt: instantSchema,
  counts: strictObject({
    groups: z.number().int().nonnegative(),
    members: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
  }),
});
export type DemoResetResponse = z.infer<typeof demoResetResponseSchema>;

export const block7EndpointPaths = {
  ownerSiteDemoReset: "POST /v1/owner/sites/:siteId/demo/reset",
} as const;

export type Block7EndpointPath =
  (typeof block7EndpointPaths)[keyof typeof block7EndpointPaths];
