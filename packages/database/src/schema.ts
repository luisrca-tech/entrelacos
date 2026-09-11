import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const adminRole = pgEnum("admin_role", ["OWNER", "SITE_ADMIN"]);
export const accountState = pgEnum("account_state", [
  "PENDING",
  "ACTIVE",
  "DISABLED",
]);
export const siteLifecycle = pgEnum("site_lifecycle", [
  "DRAFT",
  "IN_REVIEW",
  "ACTIVE",
  "INACTIVE",
]);
export const sitePublicationState = pgEnum("site_publication_state", [
  "UNPUBLISHED",
  "PUBLISHED",
  "PLACEHOLDER",
]);
export const siteDomainState = pgEnum("site_domain_state", [
  "NONE",
  "PENDING",
  "ACTIVE",
  "INACTIVE",
]);
export const adminAccessPurpose = pgEnum("admin_access_purpose", [
  "ACTIVATION",
  "RECOVERY",
]);
export const guestVerificationMode = pgEnum("guest_verification_mode", [
  "MOCK",
  "TWILIO",
]);
export const guestVerificationChallengeStatus = pgEnum(
  "guest_verification_challenge_status",
  ["PENDING", "VERIFIED", "EXPIRED", "LOCKED", "REVOKED"],
);
export const guestVerificationSendStatus = pgEnum(
  "guest_verification_send_status",
  ["RESERVED", "PROVIDER_ACCEPTED", "FAILED_FINAL", "UNKNOWN"],
);
export const guestRateLimitAction = pgEnum("guest_rate_limit_action", [
  "LOOKUP",
  "OTP_SEND",
  "OTP_VERIFY",
]);

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: adminRole("role").notNull().default("SITE_ADMIN"),
  state: accountState("state").notNull().default("PENDING"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    idToken: text("id_token"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("account_provider_account_id_idx").on(
      table.providerId,
      table.accountId,
    ),
  ],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const site = pgTable(
  "site",
  {
    id: text("id").primaryKey(),
    repositorySlug: text("repository_slug").notNull(),
    provisioningKey: text("provisioning_key").notNull(),
    displayName: text("display_name").notNull(),
    partnerOneName: text("partner_one_name").notNull(),
    partnerTwoName: text("partner_two_name").notNull(),
    eventDate: date("event_date").notNull(),
    lifecycle: siteLifecycle("lifecycle").notNull().default("DRAFT"),
    previousLifecycle: siteLifecycle("previous_lifecycle"),
    publicationState: sitePublicationState("publication_state")
      .notNull()
      .default("UNPUBLISHED"),
    isDemo: boolean("is_demo").notNull().default(false),
    publicUrl: text("public_url"),
    reviewApprovedAt: timestamp("review_approved_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("site_repository_slug_idx").on(table.repositorySlug),
    uniqueIndex("site_provisioning_key_idx").on(table.provisioningKey),
    uniqueIndex("site_public_url_idx").on(table.publicUrl),
    check(
      "site_previous_lifecycle_not_inactive_check",
      sql`${table.previousLifecycle} IS NULL OR ${table.previousLifecycle} <> 'INACTIVE'`,
    ),
    check(
      "site_inactive_requires_previous_lifecycle_check",
      sql`${table.lifecycle} <> 'INACTIVE' OR ${table.previousLifecycle} IS NOT NULL`,
    ),
  ],
);

export const guestGroup = pgTable(
  "guest_group",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    isForeign: boolean("is_foreign").notNull().default(false),
    phoneE164: text("phone_e164"),
    representativeMemberId: text("representative_member_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("guest_group_site_id_id_idx").on(table.siteId, table.id),
    uniqueIndex("guest_group_site_id_phone_e164_idx")
      .on(table.siteId, table.phoneE164)
      .where(sql`${table.phoneE164} IS NOT NULL`),
    index("guest_group_site_id_idx").on(table.siteId),
    check(
      "guest_group_name_not_blank_check",
      sql`length(trim(${table.name})) > 0`,
    ),
    check(
      "guest_group_normalized_name_not_blank_check",
      sql`length(trim(${table.normalizedName})) > 0`,
    ),
    check(
      "guest_group_phone_e164_check",
      sql`${table.phoneE164} IS NULL OR ${table.phoneE164} ~ '^[+]55[1-9]{2}9[0-9]{8}$'`,
    ),
    check(
      "guest_group_foreign_phone_check",
      sql`${table.isForeign} = (${table.phoneE164} IS NULL)`,
    ),
  ],
);

export const guestMember = pgTable(
  "guest_member",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id").notNull(),
    groupId: text("group_id").notNull(),
    fullName: text("full_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("guest_member_site_id_group_id_id_idx").on(
      table.siteId,
      table.groupId,
      table.id,
    ),
    index("guest_member_site_id_idx").on(table.siteId),
    index("guest_member_group_id_idx").on(table.groupId),
    foreignKey({
      columns: [table.siteId, table.groupId],
      foreignColumns: [guestGroup.siteId, guestGroup.id],
      name: "guest_member_site_group_fk",
    }).onDelete("cascade"),
    check(
      "guest_member_normalized_name_not_blank_check",
      sql`length(trim(${table.normalizedName})) > 0`,
    ),
  ],
);

export const guestVerificationChallenge = pgTable(
  "guest_verification_challenge",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id").notNull(),
    groupId: text("group_id").notNull(),
    mode: guestVerificationMode("mode").notNull().default("MOCK"),
    status: guestVerificationChallengeStatus("status")
      .notNull()
      .default("PENDING"),
    phoneE164: text("phone_e164").notNull(),
    codeHash: text("code_hash"),
    providerReference: text("provider_reference"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resendAvailableAt: timestamp("resend_available_at", {
      withTimezone: true,
    }).notNull(),
    wrongAttempts: integer("wrong_attempts").notNull().default(0),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationReason: text("revocation_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("guest_verification_challenge_site_id_id_idx").on(
      table.siteId,
      table.id,
    ),
    index("guest_verification_challenge_group_status_idx").on(
      table.groupId,
      table.status,
    ),
    index("guest_verification_challenge_phone_idx").on(table.phoneE164),
    foreignKey({
      columns: [table.siteId, table.groupId],
      foreignColumns: [guestGroup.siteId, guestGroup.id],
      name: "guest_verification_challenge_site_group_fk",
    }).onDelete("cascade"),
    check(
      "guest_verification_challenge_phone_e164_check",
      sql`${table.phoneE164} ~ '^[+]55[1-9]{2}9[0-9]{8}$'`,
    ),
    check(
      "guest_verification_challenge_wrong_attempts_check",
      sql`${table.wrongAttempts} BETWEEN 0 AND 5`,
    ),
    check(
      "guest_verification_challenge_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '10 minutes'`,
    ),
    check(
      "guest_verification_challenge_resend_check",
      sql`${table.resendAvailableAt} >= ${table.createdAt}`,
    ),
    check(
      "guest_verification_challenge_code_hash_check",
      sql`${table.codeHash} IS NULL OR ${table.codeHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const guestVerificationSend = pgTable(
  "guest_verification_send",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id").notNull(),
    groupId: text("group_id").notNull(),
    challengeId: text("challenge_id").notNull(),
    phoneE164: text("phone_e164").notNull(),
    status: guestVerificationSendStatus("status").notNull().default("RESERVED"),
    providerReference: text("provider_reference"),
    failureCode: text("failure_code"),
    reservedAt: timestamp("reserved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("guest_verification_send_site_id_id_idx").on(
      table.siteId,
      table.id,
    ),
    index("guest_verification_send_challenge_status_idx").on(
      table.challengeId,
      table.status,
    ),
    index("guest_verification_send_site_group_idx").on(
      table.siteId,
      table.groupId,
    ),
    foreignKey({
      columns: [table.siteId, table.groupId],
      foreignColumns: [guestGroup.siteId, guestGroup.id],
      name: "guest_verification_send_site_group_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.siteId, table.challengeId],
      foreignColumns: [
        guestVerificationChallenge.siteId,
        guestVerificationChallenge.id,
      ],
      name: "guest_verification_send_challenge_fk",
    }).onDelete("cascade"),
    check(
      "guest_verification_send_phone_e164_check",
      sql`${table.phoneE164} ~ '^[+]55[1-9]{2}9[0-9]{8}$'`,
    ),
  ],
);

export const guestRateLimitEvent = pgTable(
  "guest_rate_limit_event",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id"),
    groupId: text("group_id"),
    action: guestRateLimitAction("action").notNull(),
    scopeKey: text("scope_key").notNull(),
    ipFingerprint: text("ip_fingerprint").notNull(),
    phoneFingerprint: text("phone_fingerprint"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("guest_rate_limit_event_action_scope_time_idx").on(
      table.action,
      table.scopeKey,
      table.occurredAt,
    ),
    index("guest_rate_limit_event_site_group_time_idx").on(
      table.siteId,
      table.groupId,
      table.occurredAt,
    ),
    foreignKey({
      columns: [table.siteId, table.groupId],
      foreignColumns: [guestGroup.siteId, guestGroup.id],
      name: "guest_rate_limit_event_site_group_fk",
    }).onDelete("cascade"),
    check(
      "guest_rate_limit_event_scope_pair_check",
      sql`${table.groupId} IS NULL OR ${table.siteId} IS NOT NULL`,
    ),
  ],
);

export const familySession = pgTable(
  "family_session",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id").notNull(),
    groupId: text("group_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationReason: text("revocation_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("family_session_token_hash_idx").on(table.tokenHash),
    index("family_session_site_group_idx").on(table.siteId, table.groupId),
    index("family_session_active_expiry_idx").on(
      table.groupId,
      table.expiresAt,
    ),
    foreignKey({
      columns: [table.siteId, table.groupId],
      foreignColumns: [guestGroup.siteId, guestGroup.id],
      name: "family_session_site_group_fk",
    }).onDelete("cascade"),
    check(
      "family_session_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '7 days'`,
    ),
    check(
      "family_session_token_hash_format_check",
      sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const siteTerm = pgTable(
  "site_term",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("site_term_site_id_idx").on(table.siteId),
    check(
      "site_term_date_order_check",
      sql`${table.endsOn} >= ${table.startsOn}`,
    ),
  ],
);

export const siteDomain = pgTable(
  "site_domain",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    hostname: text("hostname").notNull(),
    state: siteDomainState("state").notNull().default("NONE"),
    isPrimary: boolean("is_primary").notNull().default(false),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    expiresOn: date("expires_on"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("site_domain_hostname_idx").on(table.hostname),
    uniqueIndex("site_domain_primary_site_id_idx")
      .on(table.siteId)
      .where(sql`${table.isPrimary} = true`),
    index("site_domain_site_id_idx").on(table.siteId),
  ],
);

export const siteOrigin = pgTable(
  "site_origin",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    origin: text("origin").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("site_origin_origin_idx").on(table.origin),
    uniqueIndex("site_origin_site_id_origin_idx").on(
      table.siteId,
      table.origin,
    ),
  ],
);

export const siteMembership = pgTable(
  "site_membership",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("site_membership_user_id_idx").on(table.userId),
    uniqueIndex("site_membership_site_id_user_id_idx").on(
      table.siteId,
      table.userId,
    ),
  ],
);

export const adminAccessToken = pgTable(
  "admin_access_token",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    siteId: text("site_id").notNull(),
    purpose: adminAccessPurpose("purpose").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("admin_access_token_hash_idx").on(table.tokenHash),
    index("admin_access_token_user_id_idx").on(table.userId),
    index("admin_access_token_site_id_idx").on(table.siteId),
    foreignKey({
      columns: [table.siteId, table.userId],
      foreignColumns: [siteMembership.siteId, siteMembership.userId],
      name: "admin_access_token_site_membership_fk",
    }).onDelete("cascade"),
    uniqueIndex("admin_access_token_active_issue_idx")
      .on(table.userId, table.purpose)
      .where(sql`${table.consumedAt} IS NULL AND ${table.revokedAt} IS NULL`),
    check(
      "admin_access_token_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "admin_access_token_hash_format_check",
      sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const userRelations = relations(user, ({ many, one }) => ({
  sessions: many(session),
  accounts: many(account),
  siteMembership: one(siteMembership),
  accessTokens: many(adminAccessToken),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const siteRelations = relations(site, ({ many, one }) => ({
  domains: many(siteDomain),
  origins: many(siteOrigin),
  memberships: many(siteMembership),
  accessTokens: many(adminAccessToken),
  guestGroups: many(guestGroup),
  guestVerificationChallenges: many(guestVerificationChallenge),
  guestVerificationSends: many(guestVerificationSend),
  guestRateLimitEvents: many(guestRateLimitEvent),
  familySessions: many(familySession),
  term: one(siteTerm),
}));

export const guestGroupRelations = relations(guestGroup, ({ one, many }) => ({
  site: one(site, {
    fields: [guestGroup.siteId],
    references: [site.id],
  }),
  members: many(guestMember),
  verificationChallenges: many(guestVerificationChallenge),
  verificationSends: many(guestVerificationSend),
  rateLimitEvents: many(guestRateLimitEvent),
  familySessions: many(familySession),
}));

export const guestMemberRelations = relations(guestMember, ({ one }) => ({
  site: one(site, {
    fields: [guestMember.siteId],
    references: [site.id],
  }),
  group: one(guestGroup, {
    fields: [guestMember.siteId, guestMember.groupId],
    references: [guestGroup.siteId, guestGroup.id],
  }),
}));

export const guestVerificationChallengeRelations = relations(
  guestVerificationChallenge,
  ({ one, many }) => ({
    site: one(site, {
      fields: [guestVerificationChallenge.siteId],
      references: [site.id],
    }),
    group: one(guestGroup, {
      fields: [
        guestVerificationChallenge.siteId,
        guestVerificationChallenge.groupId,
      ],
      references: [guestGroup.siteId, guestGroup.id],
    }),
    sends: many(guestVerificationSend),
  }),
);

export const guestVerificationSendRelations = relations(
  guestVerificationSend,
  ({ one }) => ({
    site: one(site, {
      fields: [guestVerificationSend.siteId],
      references: [site.id],
    }),
    group: one(guestGroup, {
      fields: [guestVerificationSend.siteId, guestVerificationSend.groupId],
      references: [guestGroup.siteId, guestGroup.id],
    }),
    challenge: one(guestVerificationChallenge, {
      fields: [guestVerificationSend.siteId, guestVerificationSend.challengeId],
      references: [
        guestVerificationChallenge.siteId,
        guestVerificationChallenge.id,
      ],
    }),
  }),
);

export const guestRateLimitEventRelations = relations(
  guestRateLimitEvent,
  ({ one }) => ({
    site: one(site, {
      fields: [guestRateLimitEvent.siteId],
      references: [site.id],
    }),
    group: one(guestGroup, {
      fields: [guestRateLimitEvent.siteId, guestRateLimitEvent.groupId],
      references: [guestGroup.siteId, guestGroup.id],
    }),
  }),
);

export const familySessionRelations = relations(familySession, ({ one }) => ({
  site: one(site, {
    fields: [familySession.siteId],
    references: [site.id],
  }),
  group: one(guestGroup, {
    fields: [familySession.siteId, familySession.groupId],
    references: [guestGroup.siteId, guestGroup.id],
  }),
}));

export const siteTermRelations = relations(siteTerm, ({ one }) => ({
  site: one(site, { fields: [siteTerm.siteId], references: [site.id] }),
}));

export const siteDomainRelations = relations(siteDomain, ({ one }) => ({
  site: one(site, { fields: [siteDomain.siteId], references: [site.id] }),
}));

export const siteOriginRelations = relations(siteOrigin, ({ one }) => ({
  site: one(site, { fields: [siteOrigin.siteId], references: [site.id] }),
}));

export const siteMembershipRelations = relations(siteMembership, ({ one }) => ({
  site: one(site, {
    fields: [siteMembership.siteId],
    references: [site.id],
  }),
  user: one(user, {
    fields: [siteMembership.userId],
    references: [user.id],
  }),
}));

export const adminAccessTokenRelations = relations(
  adminAccessToken,
  ({ one }) => ({
    site: one(site, {
      fields: [adminAccessToken.siteId],
      references: [site.id],
    }),
    user: one(user, {
      fields: [adminAccessToken.userId],
      references: [user.id],
    }),
  }),
);
