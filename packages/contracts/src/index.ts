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
  repositorySlug: repositorySlugSchema,
  provisioningKey: provisioningKeySchema,
  displayName: nonEmptyText(160),
  coupleNames: coupleNamesSchema,
  eventDate: calendarDateSchema,
  ...lifecycleFields,
  publicationState: sitePublicationStateSchema,
  publicUrl: publicUrlSchema.nullable(),
  trustedOrigins: z.array(originSchema).max(20),
  reviewApprovedAt: instantSchema.nullable(),
  termStartsOn: calendarDateSchema.nullable(),
  termEndsOn: calendarDateSchema.nullable(),
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
  publicUrl: publicUrlSchema.nullable(),
  termStartsOn: calendarDateSchema.nullable(),
  termEndsOn: calendarDateSchema.nullable(),
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
  password: z.string().min(12).max(200),
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
