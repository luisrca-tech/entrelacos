# Block 2 administrative access

Administrative access is split into a trusted owner panel and public,
purpose-bound consumption endpoints. Owner routes require the exact configured
panel `Origin`, an active owner session, and a `SITE_ADMIN` membership target.
An owner issues either purpose through the unified route:

`POST /v1/owner/admins/:userId/access`

The strict body is `adminAccessIssueInputSchema` and contains the path-matching
`userId` plus `purpose`, which is `ACTIVATION` or `RECOVERY`. Activation can be
issued only for a pending site administrator. Recovery can be issued only for
an active site administrator. Reissuing the same purpose revokes its previous
active token.

The public routes are purpose-bound:

- `POST /v1/auth/activation/consume`
- `POST /v1/auth/recovery/consume`

Each consumes one 43-character token, stores only its SHA-256 hash, sets the
Better Auth credential, and returns the login email with
`requiresExplicitLogin: true`. Consumption never creates a session. Activation
sets the account active. Recovery revokes every existing session. Handoff
recognition derived from those sessions becomes unusable because the handoff
recognizer rechecks its parent session on every use.

Owner recovery has no public HTTP route. The restricted
`apps/api/scripts/resetOwner.ts` command requires private environment variables
`ENTRELACOS_OWNER_RECOVERY_EMAIL`, `ENTRELACOS_OWNER_RECOVERY_PASSWORD`, and
`ENTRELACOS_DATABASE_TARGET` (`test` or `development`). It verifies the guarded
database identity, updates only the existing owner's credential, preserves the
owner identity, and revokes all owner sessions.

## Restricted commands

Run from a trusted operator shell with the private environment already loaded:

- `bun run --cwd apps/api owner:bootstrap` reads `ENTRELACOS_OWNER_EMAIL`,
  `ENTRELACOS_OWNER_NAME`, `ENTRELACOS_OWNER_PASSWORD`, and
  `ENTRELACOS_DATABASE_TARGET`. It creates an owner only when absent and preserves
  an existing owner's identity and password.
- `bun run --cwd apps/api owner:reset` reads the recovery variables above. It
  changes an existing owner's password and invalidates every existing session.

Both commands load database connection settings from the ignored database
`.env` file and verify the actual Neon branch before operating. Keep passwords
in a private environment file or secret manager, never in command arguments,
repository files, shared logs, or recovery links. Clear operator environment
variables after the operation. No command accepts a production target in this
block.

## Listening

Activation and recovery finish without a session so the user explicitly logs
in with the new password. Links use a URL fragment in the panel, which removes
it from the address bar after reading it; no raw token is sent with the initial
page request. Reset and disable invalidate derived recognition by deleting the
parent sessions, avoiding a scan through other weddings' recognition records.
