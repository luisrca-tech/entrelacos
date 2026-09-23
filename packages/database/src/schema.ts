import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
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
export const invitationAccessChallengeStatus = pgEnum(
  "invitation_access_challenge_status",
  ["PENDING", "VERIFIED", "EXPIRED", "LOCKED", "REVOKED"],
);
export const invitationRateLimitAction = pgEnum(
  "invitation_rate_limit_action",
  ["LOOKUP", "PIN_VERIFY"],
);
export const invitationGuestType = pgEnum("invitation_guest_type", [
  "ADULT",
  "CHILD",
]);
export const rsvpState = pgEnum("rsvp_state", [
  "PENDING",
  "CONFIRMED",
  "DECLINED",
]);
export const rsvpActorType = pgEnum("rsvp_actor_type", ["ADMIN", "INVITATION"]);
export const rsvpRequestScope = pgEnum("rsvp_request_scope", [
  "PUBLIC",
  "ADMIN",
]);
export const messageRequestResult = pgEnum("message_request_result", [
  "APPLIED",
  "NO_CHANGE",
  "REMOVED",
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
    rsvpDeadlineAt: timestamp("rsvp_deadline_at", { withTimezone: true }),
    rsvpDeadlineTimezone: text("rsvp_deadline_timezone"),
    muralEnabled: boolean("mural_enabled").notNull().default(false),
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
    check(
      "site_rsvp_deadline_pair_check",
      sql`(${table.rsvpDeadlineAt} IS NULL) = (${table.rsvpDeadlineTimezone} IS NULL)`,
    ),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    phoneE164: text("phone_e164").notNull(),
    email: text("email"),
    messageBlocked: boolean("message_blocked").notNull().default(false),
    messageRevision: integer("message_revision").notNull().default(0),
    manualPinSeed: text("manual_pin_seed")
      .notNull()
      .default(sql`encode(gen_random_bytes(32), 'hex')`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("invitation_site_id_id_idx").on(table.siteId, table.id),
    uniqueIndex("invitation_site_id_phone_e164_idx").on(
      table.siteId,
      table.phoneE164,
    ),
    index("invitation_site_id_idx").on(table.siteId),
    check(
      "invitation_name_not_blank_check",
      sql`length(trim(${table.name})) > 0`,
    ),
    check(
      "invitation_normalized_name_not_blank_check",
      sql`length(trim(${table.normalizedName})) > 0`,
    ),
    check(
      "invitation_phone_e164_check",
      sql`${table.phoneE164} ~ '^[+][1-9][0-9]{1,14}$'`,
    ),
    check(
      "invitation_manual_pin_seed_check",
      sql`${table.manualPinSeed} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "invitation_message_revision_check",
      sql`${table.messageRevision} >= 0`,
    ),
  ],
);

export const invitationGuest = pgTable(
  "invitation_guest",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id").notNull(),
    invitationId: text("invitation_id").notNull(),
    fullName: text("full_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    guestType: invitationGuestType("guest_type").notNull(),
    rsvpState: rsvpState("rsvp_state").notNull().default("PENDING"),
    rsvpRevision: integer("rsvp_revision").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("invitation_guest_site_id_invitation_id_id_idx").on(
      table.siteId,
      table.invitationId,
      table.id,
    ),
    index("invitation_guest_site_id_idx").on(table.siteId),
    index("invitation_guest_invitation_id_idx").on(table.invitationId),
    foreignKey({
      columns: [table.siteId, table.invitationId],
      foreignColumns: [invitation.siteId, invitation.id],
      name: "invitation_guest_site_invitation_fk",
    }).onDelete("cascade"),
    check(
      "invitation_guest_normalized_name_not_blank_check",
      sql`length(trim(${table.normalizedName})) > 0`,
    ),
    check(
      "invitation_guest_rsvp_revision_check",
      sql`${table.rsvpRevision} >= 0`,
    ),
  ],
);

export const invitationAccessChallenge = pgTable(
  "invitation_access_challenge",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id").notNull(),
    invitationId: text("invitation_id").notNull(),
    status: invitationAccessChallengeStatus("status")
      .notNull()
      .default("PENDING"),
    phoneE164: text("phone_e164").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
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
    uniqueIndex("invitation_access_challenge_site_id_id_idx").on(
      table.siteId,
      table.id,
    ),
    index("invitation_access_challenge_invitation_status_idx").on(
      table.invitationId,
      table.status,
    ),
    index("invitation_access_challenge_phone_idx").on(table.phoneE164),
    foreignKey({
      columns: [table.siteId, table.invitationId],
      foreignColumns: [invitation.siteId, invitation.id],
      name: "invitation_access_challenge_site_invitation_fk",
    }).onDelete("cascade"),
    check(
      "invitation_access_challenge_phone_e164_check",
      sql`${table.phoneE164} ~ '^[+][1-9][0-9]{1,14}$'`,
    ),
    check(
      "invitation_access_challenge_wrong_attempts_check",
      sql`${table.wrongAttempts} BETWEEN 0 AND 5`,
    ),
    check(
      "invitation_access_challenge_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '10 minutes'`,
    ),
  ],
);

export const invitationRateLimitEvent = pgTable(
  "invitation_rate_limit_event",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id"),
    invitationId: text("invitation_id"),
    action: invitationRateLimitAction("action").notNull(),
    scopeKey: text("scope_key").notNull(),
    ipFingerprint: text("ip_fingerprint").notNull(),
    phoneFingerprint: text("phone_fingerprint"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("invitation_rate_limit_event_action_scope_time_idx").on(
      table.action,
      table.scopeKey,
      table.occurredAt,
    ),
    index("invitation_rate_limit_event_occurred_at_idx").on(table.occurredAt),
    index("invitation_rate_limit_event_site_invitation_time_idx").on(
      table.siteId,
      table.invitationId,
      table.occurredAt,
    ),
    foreignKey({
      columns: [table.siteId, table.invitationId],
      foreignColumns: [invitation.siteId, invitation.id],
      name: "invitation_rate_limit_event_site_invitation_fk",
    }).onDelete("cascade"),
    check(
      "invitation_rate_limit_event_scope_pair_check",
      sql`${table.invitationId} IS NULL OR ${table.siteId} IS NOT NULL`,
    ),
  ],
);

export const invitationSession = pgTable(
  "invitation_session",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id").notNull(),
    invitationId: text("invitation_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationReason: text("revocation_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("invitation_session_token_hash_idx").on(table.tokenHash),
    index("invitation_session_site_invitation_idx").on(
      table.siteId,
      table.invitationId,
    ),
    index("invitation_session_active_expiry_idx").on(
      table.invitationId,
      table.expiresAt,
    ),
    foreignKey({
      columns: [table.siteId, table.invitationId],
      foreignColumns: [invitation.siteId, invitation.id],
      name: "invitation_session_site_invitation_fk",
    }).onDelete("cascade"),
    check(
      "invitation_session_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '7 days'`,
    ),
    check(
      "invitation_session_token_hash_format_check",
      sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const invitationMessage = pgTable(
  "invitation_message",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id").notNull(),
    invitationId: text("invitation_id").notNull(),
    authorName: text("author_name").notNull(),
    invitationName: text("invitation_name").notNull(),
    text: text("text").notNull(),
    revision: integer("revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("invitation_message_site_invitation_idx").on(
      table.siteId,
      table.invitationId,
    ),
    index("invitation_message_mural_order_idx").on(
      table.siteId,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      columns: [table.siteId, table.invitationId],
      foreignColumns: [invitation.siteId, invitation.id],
      name: "invitation_message_site_invitation_fk",
    }).onDelete("cascade"),
    check("invitation_message_revision_check", sql`${table.revision} > 0`),
    check(
      "invitation_message_author_name_not_blank_check",
      sql`length(trim(${table.authorName})) > 0`,
    ),
    check(
      "invitation_message_invitation_name_not_blank_check",
      sql`length(trim(${table.invitationName})) > 0`,
    ),
    check(
      "invitation_message_text_not_blank_check",
      sql`length(regexp_replace(${table.text}, '[[:space:]]', '', 'g')) > 0`,
    ),
    check(
      "invitation_message_text_length_check",
      sql`char_length(${table.text}) BETWEEN 1 AND 1000`,
    ),
    check(
      "invitation_message_text_no_angle_brackets_check",
      sql`position('<' in ${table.text}) = 0 AND position('>' in ${table.text}) = 0`,
    ),
    check(
      "invitation_message_text_control_chars_check",
      sql`regexp_replace(${table.text}, E'\\n', '', 'g') !~ '[[:cntrl:]]' AND ${table.text} !~ (E'[' || chr(127) || '-' || chr(159) || ']')`,
    ),
  ],
);

export const messageRequestReceipt = pgTable(
  "message_request_receipt",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    invitationId: text("invitation_id").notNull(),
    sessionId: text("session_id").notNull(),
    requestId: text("request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    revision: integer("revision").notNull(),
    result: messageRequestResult("result").notNull(),
    responseBody: jsonb("response_body"),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex(
      "message_request_receipt_site_invitation_session_request_idx",
    ).on(table.siteId, table.invitationId, table.sessionId, table.requestId),
    index("message_request_receipt_site_invitation_created_idx").on(
      table.siteId,
      table.invitationId,
      table.createdAt,
    ),
    check(
      "message_request_receipt_request_hash_check",
      sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "message_request_receipt_revision_check",
      sql`${table.revision} >= 0`,
    ),
    check(
      "message_request_receipt_removal_check",
      sql`(${table.result} = 'REMOVED' AND ${table.removedAt} IS NOT NULL AND ${table.responseBody} IS NULL) OR (${table.result} <> 'REMOVED' AND ${table.removedAt} IS NULL AND ${table.responseBody} IS NOT NULL)`,
    ),
  ],
);

export const rsvpHistory = pgTable(
  "rsvp_history",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id").notNull(),
    invitationId: text("invitation_id").notNull(),
    guestId: text("guest_id").notNull(),
    invitationName: text("invitation_name").notNull(),
    guestDisplayName: text("guest_display_name").notNull(),
    beforeState: rsvpState("before_state").notNull(),
    afterState: rsvpState("after_state").notNull(),
    actorType: rsvpActorType("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    actorDisplayName: text("actor_display_name").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("rsvp_history_site_occurred_idx").on(
      table.siteId,
      table.occurredAt,
      table.id,
    ),
    index("rsvp_history_site_invitation_idx").on(
      table.siteId,
      table.invitationId,
    ),
    index("rsvp_history_site_guest_idx").on(table.siteId, table.guestId),
    foreignKey({
      columns: [table.siteId, table.invitationId],
      foreignColumns: [invitation.siteId, invitation.id],
      name: "rsvp_history_site_invitation_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.siteId, table.invitationId, table.guestId],
      foreignColumns: [
        invitationGuest.siteId,
        invitationGuest.invitationId,
        invitationGuest.id,
      ],
      name: "rsvp_history_site_invitation_guest_fk",
    }).onDelete("cascade"),
    check(
      "rsvp_history_transition_check",
      sql`${table.beforeState} <> ${table.afterState}`,
    ),
  ],
);

export const rsvpRequestReceipt = pgTable(
  "rsvp_request_receipt",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    invitationId: text("invitation_id"),
    scope: rsvpRequestScope("scope").notNull(),
    actorType: rsvpActorType("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    requestId: text("request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: text("response_status").notNull(),
    responseBody: jsonb("response_body"),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("rsvp_request_receipt_site_id_key").on(table.siteId, table.id),
    uniqueIndex("rsvp_request_receipt_site_scope_actor_request_idx").on(
      table.siteId,
      table.scope,
      table.actorType,
      table.actorId,
      table.requestId,
    ),
    index("rsvp_request_receipt_site_created_idx").on(
      table.siteId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.siteId, table.invitationId],
      foreignColumns: [invitation.siteId, invitation.id],
      name: "rsvp_request_receipt_site_invitation_fk",
    }).onDelete("cascade"),
    check(
      "rsvp_request_receipt_request_hash_check",
      sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "rsvp_request_receipt_invitation_scope_check",
      sql`(${table.scope} = 'PUBLIC' AND ${table.invitationId} IS NOT NULL) OR (${table.scope} = 'ADMIN')`,
    ),
    check(
      "rsvp_request_receipt_removal_check",
      sql`(${table.responseStatus} = 'REMOVED' AND ${table.removedAt} IS NOT NULL AND ${table.responseBody} IS NULL) OR (${table.responseStatus} <> 'REMOVED' AND ${table.removedAt} IS NULL AND ${table.responseBody} IS NOT NULL)`,
    ),
  ],
);

export const rsvpRequestReceiptInvitation = pgTable(
  "rsvp_request_receipt_invitation",
  {
    siteId: text("site_id").notNull(),
    receiptId: text("receipt_id").notNull(),
    invitationId: text("invitation_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.siteId, table.receiptId, table.invitationId],
      name: "rsvp_request_receipt_invitation_pk",
    }),
    index("rsvp_request_receipt_invitation_lookup_idx").on(
      table.siteId,
      table.invitationId,
      table.receiptId,
    ),
    foreignKey({
      columns: [table.siteId, table.receiptId],
      foreignColumns: [rsvpRequestReceipt.siteId, rsvpRequestReceipt.id],
      name: "rsvp_request_receipt_invitation_receipt_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.siteId, table.invitationId],
      foreignColumns: [invitation.siteId, invitation.id],
      name: "rsvp_request_receipt_invitation_site_invitation_fk",
    }).onDelete("cascade"),
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
  invitations: many(invitation),
  invitationAccessChallenges: many(invitationAccessChallenge),
  invitationRateLimitEvents: many(invitationRateLimitEvent),
  invitationSessions: many(invitationSession),
  invitationMessages: many(invitationMessage),
  messageRequestReceipts: many(messageRequestReceipt),
  rsvpHistory: many(rsvpHistory),
  rsvpRequestReceipts: many(rsvpRequestReceipt),
  rsvpRequestReceiptInvitations: many(rsvpRequestReceiptInvitation),
  term: one(siteTerm),
}));

export const invitationRelations = relations(invitation, ({ one, many }) => ({
  site: one(site, {
    fields: [invitation.siteId],
    references: [site.id],
  }),
  guests: many(invitationGuest),
  accessChallenges: many(invitationAccessChallenge),
  rateLimitEvents: many(invitationRateLimitEvent),
  sessions: many(invitationSession),
  messages: many(invitationMessage),
  rsvpHistory: many(rsvpHistory),
  rsvpRequestReceipts: many(rsvpRequestReceipt),
  rsvpRequestReceiptInvitations: many(rsvpRequestReceiptInvitation),
}));

export const invitationGuestRelations = relations(
  invitationGuest,
  ({ one, many }) => ({
    site: one(site, {
      fields: [invitationGuest.siteId],
      references: [site.id],
    }),
    invitation: one(invitation, {
      fields: [invitationGuest.siteId, invitationGuest.invitationId],
      references: [invitation.siteId, invitation.id],
    }),
    rsvpHistory: many(rsvpHistory),
  }),
);

export const invitationAccessChallengeRelations = relations(
  invitationAccessChallenge,
  ({ one }) => ({
    site: one(site, {
      fields: [invitationAccessChallenge.siteId],
      references: [site.id],
    }),
    invitation: one(invitation, {
      fields: [
        invitationAccessChallenge.siteId,
        invitationAccessChallenge.invitationId,
      ],
      references: [invitation.siteId, invitation.id],
    }),
  }),
);

export const invitationRateLimitEventRelations = relations(
  invitationRateLimitEvent,
  ({ one }) => ({
    site: one(site, {
      fields: [invitationRateLimitEvent.siteId],
      references: [site.id],
    }),
    invitation: one(invitation, {
      fields: [
        invitationRateLimitEvent.siteId,
        invitationRateLimitEvent.invitationId,
      ],
      references: [invitation.siteId, invitation.id],
    }),
  }),
);

export const invitationSessionRelations = relations(
  invitationSession,
  ({ one }) => ({
    site: one(site, {
      fields: [invitationSession.siteId],
      references: [site.id],
    }),
    invitation: one(invitation, {
      fields: [invitationSession.siteId, invitationSession.invitationId],
      references: [invitation.siteId, invitation.id],
    }),
  }),
);

export const invitationMessageRelations = relations(
  invitationMessage,
  ({ one }) => ({
    site: one(site, {
      fields: [invitationMessage.siteId],
      references: [site.id],
    }),
    invitation: one(invitation, {
      fields: [invitationMessage.siteId, invitationMessage.invitationId],
      references: [invitation.siteId, invitation.id],
    }),
  }),
);

export const messageRequestReceiptRelations = relations(
  messageRequestReceipt,
  ({ one }) => ({
    site: one(site, {
      fields: [messageRequestReceipt.siteId],
      references: [site.id],
    }),
  }),
);

export const rsvpHistoryRelations = relations(rsvpHistory, ({ one }) => ({
  site: one(site, {
    fields: [rsvpHistory.siteId],
    references: [site.id],
  }),
  invitation: one(invitation, {
    fields: [rsvpHistory.siteId, rsvpHistory.invitationId],
    references: [invitation.siteId, invitation.id],
  }),
  guest: one(invitationGuest, {
    fields: [rsvpHistory.siteId, rsvpHistory.invitationId, rsvpHistory.guestId],
    references: [
      invitationGuest.siteId,
      invitationGuest.invitationId,
      invitationGuest.id,
    ],
  }),
}));

export const rsvpRequestReceiptRelations = relations(
  rsvpRequestReceipt,
  ({ one, many }) => ({
    site: one(site, {
      fields: [rsvpRequestReceipt.siteId],
      references: [site.id],
    }),
    invitation: one(invitation, {
      fields: [rsvpRequestReceipt.siteId, rsvpRequestReceipt.invitationId],
      references: [invitation.siteId, invitation.id],
    }),
    invitations: many(rsvpRequestReceiptInvitation),
  }),
);

export const rsvpRequestReceiptInvitationRelations = relations(
  rsvpRequestReceiptInvitation,
  ({ one }) => ({
    site: one(site, {
      fields: [rsvpRequestReceiptInvitation.siteId],
      references: [site.id],
    }),
    receipt: one(rsvpRequestReceipt, {
      fields: [
        rsvpRequestReceiptInvitation.siteId,
        rsvpRequestReceiptInvitation.receiptId,
      ],
      references: [rsvpRequestReceipt.siteId, rsvpRequestReceipt.id],
    }),
    invitation: one(invitation, {
      fields: [
        rsvpRequestReceiptInvitation.siteId,
        rsvpRequestReceiptInvitation.invitationId,
      ],
      references: [invitation.siteId, invitation.id],
    }),
  }),
);

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
