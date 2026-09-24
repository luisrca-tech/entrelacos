import parsePhoneNumber, { AsYouType } from "libphonenumber-js";
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
  password: z.string().min(6).max(10),
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

export const invitationPhoneE164Schema = z
  .string()
  .regex(/^\+[1-9][0-9]{1,14}$/, "Expected an E.164 phone number");

export const invitationPhoneInputSchema = z
  .string()
  .min(1)
  .max(40)
  .transform((value) => {
    const phone = parsePhoneNumber(value, {
      defaultCountry: "BR",
      extract: false,
    });
    return phone?.isPossible() && !phone.ext ? phone.number : "";
  })
  .pipe(invitationPhoneE164Schema);

export function formatInvitationPhoneInput(value: string): string {
  return new AsYouType("BR").input(value);
}

const invitationEmailValueSchema = z
  .string()
  .max(320)
  .transform((value) => {
    const normalized = value.trim().toLowerCase();
    return normalized === "" ? null : normalized;
  })
  .pipe(z.string().email().max(320).nullable());

export const invitationEmailInputSchema = z
  .union([z.string().max(320), z.null()])
  .optional()
  .transform((value) => (value === undefined || value === null ? null : value))
  .pipe(invitationEmailValueSchema.or(z.null()));

export const invitationGuestTypeSchema = z.enum(["ADULT", "CHILD"]);
export type InvitationGuestType = z.infer<typeof invitationGuestTypeSchema>;
export const rsvpStateSchema = z.enum(["PENDING", "CONFIRMED", "DECLINED"]);
export type RsvpState = z.infer<typeof rsvpStateSchema>;

export const invitationGuestInputSchema = strictObject({
  id: identifierSchema.optional(),
  fullName: nonEmptyText(160),
  guestType: invitationGuestTypeSchema,
});

const invitationGuestsInputSchema = z
  .array(invitationGuestInputSchema)
  .min(1, "At least one guest is required");

export const invitationCreateInputSchema = strictObject({
  name: nonEmptyText(160),
  phone: invitationPhoneInputSchema,
  email: invitationEmailInputSchema,
  guests: invitationGuestsInputSchema,
});
export type InvitationCreateInput = z.infer<typeof invitationCreateInputSchema>;

export const invitationUpdateInputSchema = strictObject({
  name: nonEmptyText(160).optional(),
  phone: invitationPhoneInputSchema.optional(),
  email: invitationEmailInputSchema.optional(),
  guests: invitationGuestsInputSchema.optional(),
}).superRefine((value, context) => {
  if (Object.keys(value).length === 0) {
    context.addIssue({
      code: "custom",
      message: "At least one invitation field is required",
    });
  }
});
export type InvitationUpdateInput = z.infer<typeof invitationUpdateInputSchema>;

export const invitationGuestRecordSchema = strictObject({
  id: identifierSchema,
  fullName: nonEmptyText(160),
  guestType: invitationGuestTypeSchema,
  rsvpState: rsvpStateSchema,
  rsvpRevision: z.number().int().nonnegative(),
});

const invitationGuestRecordsSchema = z
  .array(invitationGuestRecordSchema)
  .min(1, "At least one guest is required");

export const invitationRecordSchema = strictObject({
  id: identifierSchema,
  siteId: siteIdSchema,
  name: nonEmptyText(160),
  phone: invitationPhoneE164Schema,
  email: z.string().email().max(320).nullable(),
  guests: invitationGuestRecordsSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type InvitationRecord = z.infer<typeof invitationRecordSchema>;

export const invitationResponseSchema = strictObject({
  invitation: invitationRecordSchema,
});

export const invitationListResponseSchema = strictObject({
  invitations: z.array(invitationRecordSchema),
});

export const invitationDeleteResponseSchema = adminMutationResponseSchema;

export const invitationLookupInputSchema = strictObject({
  phone: invitationPhoneInputSchema,
});
export type InvitationLookupInput = z.infer<typeof invitationLookupInputSchema>;

export const invitationAccessPinSchema = z
  .string()
  .regex(/^\d{6}$/, "Expected a six-digit access PIN");
export const invitationAccessInputSchema = strictObject({
  phone: invitationPhoneInputSchema,
  accessPin: invitationAccessPinSchema,
});
export type InvitationAccessInput = z.infer<typeof invitationAccessInputSchema>;
export const invitationAccessPinResponseSchema = strictObject({
  accessPin: invitationAccessPinSchema,
});
export type InvitationAccessPinResponse = z.infer<
  typeof invitationAccessPinResponseSchema
>;

export const invitationSessionGuestSchema = strictObject({
  id: identifierSchema,
  fullName: nonEmptyText(160),
  guestType: invitationGuestTypeSchema,
  rsvpState: rsvpStateSchema,
});

export const invitationSessionResponseSchema = strictObject({
  sessionToken: opaqueTokenSchema,
  siteId: siteIdSchema,
  invitationId: identifierSchema,
  invitationName: nonEmptyText(160),
  guests: z.array(invitationSessionGuestSchema).min(1),
  expiresAt: instantSchema,
});
export type InvitationSessionResponse = z.infer<
  typeof invitationSessionResponseSchema
>;

export const invitationSessionReadResponseSchema = strictObject({
  siteId: siteIdSchema,
  invitationId: identifierSchema,
  invitationName: nonEmptyText(160),
  guests: z.array(invitationSessionGuestSchema).min(1),
  expiresAt: instantSchema,
});
export type InvitationSessionReadResponse = z.infer<
  typeof invitationSessionReadResponseSchema
>;

export const invitationSessionLeaveResponseSchema = adminMutationResponseSchema;

export const invitationEndpointPaths = {
  siteInvitationsList: "GET /v1/sites/:siteId/invitations",
  siteInvitationsCreate: "POST /v1/sites/:siteId/invitations",
  siteInvitationUpdate: "PATCH /v1/sites/:siteId/invitations/:invitationId",
  siteInvitationDelete: "DELETE /v1/sites/:siteId/invitations/:invitationId",
  siteInvitationAccessPin:
    "GET /v1/sites/:siteId/invitations/:invitationId/access-pin",
  siteInvitationAccessPinRotate:
    "POST /v1/sites/:siteId/invitations/:invitationId/access-pin/rotate",
  publicInvitationAccess: "POST /v1/public/sites/:siteId/invitation/access",
  publicInvitationSession: "GET /v1/public/invitation/session",
  publicInvitationSessionLeave: "POST /v1/public/invitation/session/leave",
} as const;

export type InvitationEndpointPath =
  (typeof invitationEndpointPaths)[keyof typeof invitationEndpointPaths];

export const rsvpActorTypeSchema = z.enum(["ADMIN", "INVITATION"]);
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

export const rsvpGuestRecordSchema = strictObject({
  id: identifierSchema,
  fullName: nonEmptyText(160),
  guestType: invitationGuestTypeSchema,
  state: rsvpStateSchema,
  revision: z.number().int().nonnegative(),
});
export type RsvpGuestRecord = z.infer<typeof rsvpGuestRecordSchema>;

const rsvpGuestUpdateSchema = strictObject({
  guestId: identifierSchema,
  state: rsvpStateSchema,
  expectedRevision: z.number().int().nonnegative(),
});
export type RsvpGuestUpdate = z.infer<typeof rsvpGuestUpdateSchema>;

function uniqueGuestUpdates<T extends z.ZodTypeAny>(schema: T) {
  return strictObject({
    requestId: z.string().uuid(),
    guests: z.array(schema).min(1).max(500),
  }).superRefine((value, context) => {
    const ids = new Set<string>();
    for (const guest of value.guests as Array<{ guestId: string }>) {
      if (ids.has(guest.guestId)) {
        context.addIssue({
          code: "custom",
          path: ["guests"],
          message: "RSVP guest updates must be unique",
        });
      }
      ids.add(guest.guestId);
    }
  });
}

export const invitationRsvpWriteInputSchema = uniqueGuestUpdates(
  rsvpGuestUpdateSchema,
);
export const adminRsvpWriteInputSchema = invitationRsvpWriteInputSchema;
export type InvitationRsvpWriteInput = z.infer<
  typeof invitationRsvpWriteInputSchema
>;
export type AdminRsvpWriteInput = z.infer<typeof adminRsvpWriteInputSchema>;

export const invitationRsvpResponseSchema = strictObject({
  siteId: siteIdSchema,
  invitationId: identifierSchema,
  invitationName: nonEmptyText(160),
  deadlineAt: instantSchema.nullable(),
  deadlineTimezone: ianaTimezoneSchema.nullable(),
  serverNow: instantSchema,
  canEdit: z.boolean(),
  readOnlyReason: z.enum(["DEADLINE_PASSED"]).nullable(),
  guests: z.array(rsvpGuestRecordSchema).min(1),
});
export type InvitationRsvpResponse = z.infer<
  typeof invitationRsvpResponseSchema
>;

export const rsvpWriteResponseSchema = strictObject({
  requestId: z.string().uuid(),
  acceptedAt: instantSchema,
  result: z.enum(["APPLIED", "NO_CHANGE"]),
  replayed: z.boolean(),
  guests: z.array(rsvpGuestRecordSchema).min(1),
});
export type RsvpWriteResponse = z.infer<typeof rsvpWriteResponseSchema>;

export const rsvpTotalsSchema = strictObject({
  pending: z.number().int().nonnegative(),
  confirmed: z.number().int().nonnegative(),
  declined: z.number().int().nonnegative(),
});

export const rsvpInvitationRecordSchema = strictObject({
  id: identifierSchema,
  name: nonEmptyText(160),
  guests: z.array(rsvpGuestRecordSchema),
  totals: rsvpTotalsSchema,
});

export const siteRsvpQuerySchema = strictObject({
  invitationId: identifierSchema.optional(),
  state: rsvpStateSchema.optional(),
});

export const siteRsvpResponseSchema = strictObject({
  siteId: siteIdSchema,
  lifecycle: z.enum(["DRAFT", "IN_REVIEW", "ACTIVE", "INACTIVE"]),
  deadlineAt: instantSchema.nullable(),
  deadlineTimezone: ianaTimezoneSchema.nullable(),
  totals: rsvpTotalsSchema,
  invitations: z.array(rsvpInvitationRecordSchema),
});
export type SiteRsvpResponse = z.infer<typeof siteRsvpResponseSchema>;

export const rsvpHistoryQuerySchema = strictObject({
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  invitationId: identifierSchema.optional(),
  guestId: identifierSchema.optional(),
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
  invitationId: identifierSchema,
  invitationName: nonEmptyText(160),
  guestId: identifierSchema,
  guestDisplayName: nonEmptyText(160),
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
  publicInvitationRsvpRead: "GET /v1/public/invitation/rsvp",
  publicInvitationRsvpWrite: "POST /v1/public/invitation/rsvp",
  siteRsvpRead: "GET /v1/sites/:siteId/rsvp",
  siteRsvpWrite: "POST /v1/sites/:siteId/rsvp",
  siteRsvpDeadlineRead: "GET /v1/sites/:siteId/rsvp/deadline",
  siteRsvpDeadlineUpdate: "PATCH /v1/sites/:siteId/rsvp/deadline",
  siteRsvpHistoryRead: "GET /v1/sites/:siteId/rsvp/history",
} as const;

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

const publicMessageAuthorNameSchema = z
  .string()
  .transform((value) => value.trim().replace(/\s+/gu, " "))
  .refine((value) => {
    const length = Array.from(value).length;
    return (
      length >= 1 &&
      length <= 160 &&
      !/[<>]/u.test(value) &&
      !Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || (code >= 127 && code <= 159);
      })
    );
  }, "Expected plain text with 1-160 Unicode code points");

export const publicSiteMessageRecordSchema = strictObject({
  id: identifierSchema,
  authorName: publicMessageAuthorNameSchema,
  text: messageTextSchema,
  createdAt: instantSchema,
});
export type PublicSiteMessageRecord = z.infer<
  typeof publicSiteMessageRecordSchema
>;

export const createPublicSiteMessageRequestSchema = strictObject({
  requestId: z.string().uuid(),
  authorName: publicMessageAuthorNameSchema,
  text: messageTextSchema,
});
export type CreatePublicSiteMessageRequest = z.infer<
  typeof createPublicSiteMessageRequestSchema
>;

export const createPublicSiteMessageResponseSchema = strictObject({
  requestId: z.string().uuid(),
  acceptedAt: instantSchema,
  replayed: z.boolean(),
  message: publicSiteMessageRecordSchema,
});
export type CreatePublicSiteMessageResponse = z.infer<
  typeof createPublicSiteMessageResponseSchema
>;

export const publicMuralQuerySchema = strictObject({
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PublicMuralQuery = z.infer<typeof publicMuralQuerySchema>;

export const publicMuralResponseSchema = strictObject({
  enabled: z.boolean(),
  messages: z.array(publicSiteMessageRecordSchema),
  nextCursor: z.string().min(1).max(500).nullable(),
});
export type PublicMuralResponse = z.infer<typeof publicMuralResponseSchema>;

export const siteMessagesQuerySchema = strictObject({
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(160).optional(),
});

export const siteMessageRecordSchema = publicSiteMessageRecordSchema;
export type SiteMessageRecord = PublicSiteMessageRecord;

export const siteMessagesResponseSchema = strictObject({
  messages: z.array(siteMessageRecordSchema),
  nextCursor: z.string().min(1).max(500).nullable(),
});
export type SiteMessagesResponse = z.infer<typeof siteMessagesResponseSchema>;

export const muralConfigurationSchema = strictObject({ enabled: z.boolean() });
export type MuralConfiguration = z.infer<typeof muralConfigurationSchema>;

export const muralConfigurationResponseSchema = strictObject({
  siteId: siteIdSchema,
  enabled: z.boolean(),
});

export const invitationDeleteConfirmationSchema = strictObject({
  confirmInvitationId: identifierSchema,
  confirmInvitationName: nonEmptyText(160),
});
export type InvitationDeleteConfirmation = z.infer<
  typeof invitationDeleteConfirmationSchema
>;

const explicitBooleanQuerySchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

export const invitationExportQuerySchema = strictObject({
  requestId: z.string().uuid(),
  search: z
    .string()
    .trim()
    .max(160)
    .optional()
    .transform((value) => (value === "" ? undefined : value)),
  status: rsvpStateSchema.optional(),
  guestType: invitationGuestTypeSchema.optional(),
  includePhone: explicitBooleanQuerySchema.optional().default(false),
  includeEmail: explicitBooleanQuerySchema.optional().default(false),
});
export type InvitationExportQuery = z.infer<typeof invitationExportQuerySchema>;

export const block5ErrorCodeSchema = z.enum([
  "MURAL_DISABLED",
  "SITE_INACTIVE",
  "FORBIDDEN",
  "RATE_LIMITED",
  "MESSAGE_CONFLICT",
  "MESSAGE_REMOVED",
  "MESSAGE_NOT_FOUND",
  "INVITATION_CONFIRMATION_MISMATCH",
  "RSVP_RESULT_REMOVED",
]);

export const block5EndpointPaths = {
  publicMuralRead: "GET /v1/public/sites/:siteId/mural",
  publicMuralCreate: "POST /v1/public/sites/:siteId/mural",
  siteMessagesRead: "GET /v1/sites/:siteId/messages",
  siteMuralRead: "GET /v1/sites/:siteId/mural",
  siteMuralUpdate: "PATCH /v1/sites/:siteId/mural",
  siteMessageDelete: "DELETE /v1/sites/:siteId/messages/:messageId",
  siteInvitationDelete: "DELETE /v1/sites/:siteId/invitations/:invitationId",
  siteInvitationCsvExport: "GET /v1/sites/:siteId/reports/invitations.csv",
  siteInvitationPdfExport: "GET /v1/sites/:siteId/reports/invitations.pdf",
} as const;

export type Block5EndpointPath =
  (typeof block5EndpointPaths)[keyof typeof block5EndpointPaths];

export const demoResetDatasetVersionSchema = z.literal("block7-demo-v2");
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
    invitations: z.number().int().nonnegative(),
    guests: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
  }),
});
export type DemoResetResponse = z.infer<typeof demoResetResponseSchema>;

export const block7EndpointPaths = {
  ownerSiteDemoReset: "POST /v1/owner/sites/:siteId/demo/reset",
} as const;

export type Block7EndpointPath =
  (typeof block7EndpointPaths)[keyof typeof block7EndpointPaths];
