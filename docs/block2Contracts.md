# Block 2 contracts and persistence boundary

This document freezes the shared boundary for the tenant, site lifecycle, and
controlled administrative access work. Runtime authorization and transition
rules remain API service responsibilities. The database owns identity,
foreign keys, uniqueness, date ordering, and token storage constraints.

## Public contract exports

All exports are in `@entrelacos/contracts` from
`packages/contracts/src/index.ts`. Every request and response object is a
strict Zod object; unknown keys are rejected. The package exports inferred
types beside the primary input/output schemas.

The common primitives are `siteIdSchema`, `repositorySlugSchema`,
`provisioningKeySchema`, `calendarDateSchema`, `instantSchema`,
`publicUrlSchema`, `originSchema`, `domainNameSchema`,
`opaqueTokenSchema`, `adminRoleSchema`, `accountStateSchema`,
`siteLifecycleSchema`, `sitePublicationStateSchema`,
`siteDomainStateSchema`, and `adminAccessPurposeSchema`.

`publicUrlSchema` accepts HTTPS site-root URLs. For local development it also
accepts HTTP site-root URLs whose host is `localhost`, `127.0.0.1`, or `::1`.
`originSchema` requires the exact URL origin with no path, query, fragment,
credentials, or arbitrary HTTP host. Credentials, `javascript:` URLs, and
open redirect destinations are rejected.

The site contracts are:

- `ownerSiteCreateInputSchema`
- `ownerSiteResumeInputSchema`
- `ownerSiteListQuerySchema` and `ownerSiteListResponseSchema`
- `ownerSiteResponseSchema`, `ownerSiteCreateResponseSchema`,
  `ownerSiteResumeResponseSchema`, `ownerSiteUpdateResponseSchema`, and
  `ownerSiteLifecycleResponseSchema`
- `siteRecordSchema` and `siteScopedReadResponseSchema`
- `siteUpdateInputSchema`, `siteStartReviewInputSchema`,
  `siteReviewApproveInputSchema`, `sitePublicationUpdateInputSchema`, and
  `dateEditInputSchema`
- `siteDomainRecordSchema`, `siteDomainCreateInputSchema`,
  `siteDomainUpdateInputSchema`, and `siteDomainListResponseSchema`

Site creation requires a unique `repositorySlug` and stable
`provisioningKey`. Creation starts in `DRAFT`. Review approval accepts an
empty body; the service sets approval time from its clock and starts the
default calendar-year term. Clients edit the event and term calendar dates
only through `dateEditInputSchema`.

The admin contracts are:

- `adminCreateInputSchema`, `ownerAdminCreateInputSchema`, `adminSummarySchema`, and
  `adminListResponseSchema`
- `adminAccessIssueInputSchema`, `ownerActivationIssueInputSchema`,
  `ownerRecoveryIssueInputSchema`, and `adminAccessIssueResponseSchema`
- `adminAccessRevokeInputSchema`, `adminDisableInputSchema`, and
  `adminMutationResponseSchema`
- `publicAccessConsumeInputSchema` and `publicAccessConsumeResponseSchema`
- `meResponseSchema` and `safeActorSchema`

The public access consumer is for a site administrator only. It sets the
password and returns the login email plus `requiresExplicitLogin: true`; it
does not create a session. Owner recovery is a restricted server procedure,
with no public owner recovery route. The raw token may be returned once for
manual delivery, but it is never a database field.

The handoff contracts are `handoffIssueInputSchema`,
`handoffIssueResponseSchema`, `handoffRedeemInputSchema`,
`handoffRedeemResponseSchema`, and `handoffRecognitionInputSchema`.
Issuance includes the caller's 64-character lowercase SHA-256 challenge;
redemption includes the 43-character verifier. Services must compare both
proofs and look up the exact registered origin for the site before issuing or
redeeming. Handoff never accepts an arbitrary return URL.

The exact route strings are exported as `block2EndpointPaths` (and the
`Block2EndpointPath` type):

| Operation | Route | Input | Output |
| --- | --- | --- | --- |
| Owner list sites | `GET /v1/owner/sites` | `ownerSiteListQuerySchema` | `ownerSiteListResponseSchema` |
| Owner create site | `POST /v1/owner/sites` | `ownerSiteCreateInputSchema` | `ownerSiteCreateResponseSchema` |
| Owner resume site | `POST /v1/owner/sites/resume` | `ownerSiteResumeInputSchema` | `ownerSiteResumeResponseSchema` |
| Owner get site | `GET /v1/owner/sites/:siteId` | none | `ownerSiteResponseSchema` |
| Owner update site | `PATCH /v1/owner/sites/:siteId` | `siteUpdateInputSchema` | `ownerSiteUpdateResponseSchema` |
| Start review | `POST /v1/owner/sites/:siteId/review/start` | `siteStartReviewInputSchema` | `ownerSiteLifecycleResponseSchema` |
| Approve review and start term | `POST /v1/owner/sites/:siteId/review/approve` | `siteReviewApproveInputSchema` | `ownerSiteLifecycleResponseSchema` |
| Deactivate site | `POST /v1/owner/sites/:siteId/deactivate` | empty object | `ownerSiteLifecycleResponseSchema` |
| Reactivate site | `POST /v1/owner/sites/:siteId/reactivate` | empty object | `ownerSiteLifecycleResponseSchema` |
| Edit event/term dates | `PATCH /v1/owner/sites/:siteId/dates` | `dateEditInputSchema` | `ownerSiteLifecycleResponseSchema` |
| Update publication state | `PATCH /v1/owner/sites/:siteId/publication` | `sitePublicationUpdateInputSchema` | `ownerSiteLifecycleResponseSchema` |
| Site-scoped read | `GET /v1/sites/:siteId` | none | `siteScopedReadResponseSchema` |
| Owner create admin | `POST /v1/owner/sites/:siteId/admins` | `ownerAdminCreateInputSchema` | `adminSummarySchema` |
| Owner list admins | `GET /v1/owner/sites/:siteId/admins` | none | `adminListResponseSchema` |
| Owner issue activation or recovery | `POST /v1/owner/admins/:userId/access` | `adminAccessIssueInputSchema` | `adminAccessIssueResponseSchema` |
| Owner revoke access | `POST /v1/owner/admins/:userId/access/revoke` | `adminAccessRevokeInputSchema` | `adminMutationResponseSchema` |
| Owner disable admin | `POST /v1/owner/admins/:userId/disable` | `adminDisableInputSchema` | `adminMutationResponseSchema` |
| Owner create domain | `POST /v1/owner/sites/:siteId/domains` | `siteDomainCreateInputSchema` | `siteDomainRecordSchema` |
| Owner list domains | `GET /v1/owner/sites/:siteId/domains` | none | `siteDomainListResponseSchema` |
| Owner update domain | `PATCH /v1/owner/sites/:siteId/domains/:domainId` | `siteDomainUpdateInputSchema` | `siteDomainRecordSchema` |
| Consume activation | `POST /v1/auth/activation/consume` | `publicAccessConsumeInputSchema` | `publicAccessConsumeResponseSchema` |
| Consume site-admin recovery | `POST /v1/auth/recovery/consume` | `publicAccessConsumeInputSchema` | `publicAccessConsumeResponseSchema` |
| Read current actor | `GET /v1/me` | none | `meResponseSchema` |
| Issue handoff | `POST /v1/handoff` | `handoffIssueInputSchema` | `handoffIssueResponseSchema` |
| Redeem handoff | `POST /v1/handoff/redeem` | `handoffRedeemInputSchema` | `handoffRedeemResponseSchema` |
| Recognize site | `POST /v1/handoff/recognize` | `handoffRecognitionInputSchema` | `handoffRecognitionResponseSchema` |

`/v1/me` returns the existing safe user and session shape and adds optional
`siteId`. It never returns Better Auth session tokens, password material,
activation hashes, recovery hashes, or another site's membership.

## Database tables and constraints

`packages/database/src/schema.ts` preserves the Better Auth `user`,
`session`, `account`, and `verification` tables. New tables are:

- `site`: stable ID, unique repository slug and provisioning key, couple
  names, event date, lifecycle, previous non-inactive lifecycle, publication
  state, public URL, and review timestamp.
- `site_term`: one row per site with approval time and calendar start/end.
  The database checks that the end is on or after the start.
- `site_domain`: site-scoped domain records with independent state and
  expiry/renewal date. Hostnames are globally unique.
- `site_origin`: exact trusted origins. Origins are globally unique and
  cascade with their site.
- `site_membership`: `siteId` and `userId` foreign keys. A unique index on
  `userId` gives each `SITE_ADMIN` at most one site membership; OWNER access
  remains global and does not require membership.
- `admin_access_token`: user-bound and purpose-bound site-admin
  activation/recovery rows. Its composite foreign key binds `(siteId, userId)`
  to the unique membership row. It stores only `tokenHash`, requires a
  64-character lowercase SHA-256 hash, expires after creation, and has one
  active row per `(userId, purpose)` through a partial unique index. Services
  revoke the old row before issuing a replacement and atomically mark consumed
  rows.

The schema does not encode authorization transitions or infer role from a
submitted `siteId`. Services must require OWNER for global routes and resolve
SITE_ADMIN access through the unique membership row. Site deactivation keeps
all site and operational rows; it changes lifecycle/publication behavior and
never deletes guest or authentication data.

## Migration review boundary

`0001_block2_contracts.sql` adds the enums and tables above, including the
token hash-format check. Both migrations were reviewed and applied to the
identity-verified test and development databases on 2026-09-11. Repeating the
migration command was harmless. Production was not connected or migrated.

The focused contract test is
`packages/contracts/src/index.test.ts`. It covers strict payloads, role
escalation rejection, unsafe URL rejection, lifecycle/date validation,
site-bound admin access, safe actor output, explicit login, and handoff proof
binding.
