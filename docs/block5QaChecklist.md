# Block 5 end-to-end QA checklist

Status: executed for the authorized local Block 5 boundary on 2026-09-12. The sanitized outcomes, defects corrected, automated counts, cleanup, and remaining external limits are recorded in `docs/block5Validation.md`. The unchecked boxes below remain the reusable procedure; the validation record is the source of truth for what was exercised.

## Preconditions and identity

- [ ] Confirm the Block 5 branch, base revision, complete diff, and target build.
- [ ] Use distinct local API, admin, and public-demo origins registered for the fixture wedding.
- [ ] Verify the disposable PostgreSQL project, branch, endpoint, database, and role before any mutation. Use `DATABASE_URL_TEST` only; never fall back to `DATABASE_URL`.
- [ ] Apply only the reviewed Block 5 migration to the verified test target. Never connect to production.
- [ ] Use synthetic OWNER, assigned SITE_ADMIN, family representative, second group, foreign group, inactive site, and second-site sentinel identities.
- [ ] Obtain administrative and family sessions through supported authentication flows. Do not put credentials, tokens, PINs, phones, or private records in repository files or evidence.
- [ ] Use unique fixture names and serialize setup, browser mutations, database suites, and cleanup against the shared disposable database.
- [ ] Keep real Twilio disabled. Use manual PIN for the normal MVP path and deterministic simulation only for SMS quota cases.

## Family message

- [ ] Restore an existing family session and confirm no second authentication or freely typed author field appears.
- [ ] Publish a message and verify the displayed author and group use registered values.
- [ ] Verify emoji and line breaks persist across reload and another browser session.
- [ ] Verify exactly 1,000 Unicode code points succeed and 1,001 fail without a partial write.
- [ ] Verify blank text, angle brackets, HTML, attachments, multipart bodies, control characters, and extra fields fail honestly.
- [ ] Edit the current message and verify creation time stays fixed, update time changes, and the mural position does not change.
- [ ] Submit identical content and verify no false edit time or revision change is reported.
- [ ] Repeat an identical request after a lost response and verify replay without another mutation.
- [ ] Reuse the request ID with changed content and verify `IDEMPOTENCY_KEY_REUSED`.
- [ ] Submit two writes from the same revision and verify one success and one `MESSAGE_CONFLICT`.
- [ ] Revoke or expire the session while the editor is open and verify stale success state is cleared.
- [ ] Attempt access with another site's origin, group identifier, or bearer and verify no tenant data is exposed.

## Public mural and privacy

- [ ] Read the mural without a family session from the exact registered public origin.
- [ ] Verify the response and rendered page contain author name, group name, text, and required timestamps only.
- [ ] Inspect HTML, JavaScript state, network responses, console, URLs, and accessibility tree for phones, member lists, RSVP, sessions, revisions, PINs, and admin data.
- [ ] Verify descending creation order and stable ID tie-breaking over more than one page.
- [ ] Edit an older message and verify it retains its original ordering position.
- [ ] Delete a message between page loads and verify a first-page refresh removes stale loaded pages.
- [ ] Verify refresh on mount, visibility return, local action, and the visible 30-second interval using controlled evidence.
- [ ] Induce API failure and verify an honest unavailable state without claiming the last view is current.
- [ ] Build and render static editorial content while API, database, and SMS provider are unavailable.

## Mural controls and moderation

- [ ] Disable the mural as OWNER and assigned SITE_ADMIN; verify public output is empty and family writes receive `MURAL_DISABLED`.
- [ ] Verify stored messages reappear after re-enabling without being recreated.
- [ ] Block a group and verify its existing message remains visible while create/edit receives `MESSAGE_BLOCKED`.
- [ ] Verify blocking does not revoke the family session or prevent family/admin RSVP reads and writes.
- [ ] Unblock the group and verify message editing becomes available without reauthentication.
- [ ] Delete the current message as OWNER and SITE_ADMIN; verify the admin cannot edit its text.
- [ ] Retry an editor state opened before deletion and verify it cannot restore the deleted text.
- [ ] Republish after deletion and verify fresh registered attribution and a later durable revision.
- [ ] Verify a site-assigned admin cannot read or moderate another wedding.
- [ ] Verify inactive-site administration remains readable but rejects mural, block, and message mutations.

## Safe group deletion

- [ ] Open destructive confirmation and verify it names the group and explains members, RSVP/history, messages, sessions, and challenges will be removed.
- [ ] Cancel confirmation and verify no API deletion and no state change.
- [ ] Submit the wrong name or group ID and verify `GROUP_CONFIRMATION_MISMATCH` without partial deletion.
- [ ] Confirm the exact target and verify one successful transaction removes the group and its owned records.
- [ ] Verify the former family session fails and no pending or completed challenge can create access for the deleted group.
- [ ] Verify a public or administrative message request racing with deletion cannot recreate the group or message.
- [ ] Verify affected public message receipts cannot return deleted text.
- [ ] Verify an administrative RSVP receipt spanning the deleted and a retained group is redacted and later returns `RSVP_RESULT_REMOVED` without reapplying either update.
- [ ] Repeat deletion and verify `GROUP_NOT_FOUND` without affecting other records.
- [ ] Verify another group, another site, and the complete sentinel tenant remain byte-for-byte equivalent in the tested business records.
- [ ] Verify site-level monthly SMS usage does not decrease after group deletion.

## CSV export

- [ ] Download CSV as OWNER and assigned SITE_ADMIN from active and inactive sites.
- [ ] Verify content type, UTF-8 BOM, CRLF records, attachment header, and safe deterministic filename.
- [ ] Verify header, generation data, timezone, selected filters, whole-site totals, selected totals, groups, members, and RSVP states.
- [ ] Export without phone and verify the column and every phone value are absent.
- [ ] Export with phone and verify only each group's representative phone appears; foreign-group phone stays empty.
- [ ] Exercise group and each RSVP-state filter, including a valid empty selection.
- [ ] Verify deterministic ordering when group/member names are equal.
- [ ] Use names beginning with `=`, `+`, `-`, `@`, tab, CR, and LF plus quotes and commas; verify the opened spreadsheet treats each as text and records remain aligned.
- [ ] Verify accents and supported Unicode round-trip correctly.
- [ ] Search the file for messages, history, IDs, revisions, PINs, sessions, receipts, and second-site values; expect none.
- [ ] Verify a forged group filter from another site returns no foreign data.

## PDF export

- [ ] Download and open PDF as OWNER and assigned SITE_ADMIN from active and inactive sites.
- [ ] Verify content type, attachment header, cache policy, safe filename, and readable document metadata.
- [ ] Verify the same filters, totals, phone option, ordering, and exclusions as CSV.
- [ ] Verify accents and the approved Unicode fixture names render as glyphs, not blank boxes or replacement characters.
- [ ] Use enough members and long names to create multiple pages; inspect page breaks, repeated headings, margins, rows, and page X/Y labels.
- [ ] Print or preview A4 portrait output and verify no clipped or overlapping content.
- [ ] Induce generation failure and verify a structured problem response rather than a successful partial PDF.
- [ ] Search extracted PDF text for messages and second-site values; expect none.

## Monthly SMS quota

- [ ] Verify no numeric default is displayed and real SMS remains blocked with `SMS_QUOTA_NOT_CONFIGURED`.
- [ ] Verify only OWNER can configure the limit; SITE_ADMIN may read usage but cannot change it.
- [ ] Confirm manual PIN lookup/verification creates no SMS reservation and works without a quota.
- [ ] Use a deterministic server clock to exercise month start, month end, and the next `America/Sao_Paulo` civil month.
- [ ] Verify separate `SIMULATED` and `REAL_SMS` counters and labels; never present simulated usage as provider usage.
- [ ] Exercise 79%, 80%, 99%, and 100% with exact alert transitions.
- [ ] Verify a zero limit blocks new SMS reservations while manual PIN, sessions, public RSVP, and administrative RSVP remain available.
- [ ] Submit concurrent requests for the final available unit and verify exactly one reservation and at most the configured total.
- [ ] Verify initial sends and resends both consume one reservation before provider dispatch.
- [ ] Verify `RESERVED`, `PROVIDER_ACCEPTED`, `FAILED_FINAL`, and `UNKNOWN` all consume quota and no failure receives an automatic refund.
- [ ] Verify an unknown result receives no automatic retry.
- [ ] Lower the limit below current consumption and verify new sends block; raise it and verify available capacity returns.
- [ ] Verify deletion/recreation of a group does not reduce site usage.
- [ ] Verify site and period substitution cannot read or consume another wedding's quota.

## Responsive, accessibility, and failure behavior

- [ ] Exercise family message and mural on desktop and a 390x844 mobile viewport with no horizontal overflow.
- [ ] Verify keyboard navigation, focus movement/return, labels, live status, alerts, disabled controls, and destructive confirmation.
- [ ] Verify loading, success, no-op, conflict, expired session, mural disabled, group blocked, API unavailable, site inactive, export failure, quota missing, and quota exhausted messages are immediate and honest.
- [ ] Inspect the browser console and network log for uncaught errors, false-success responses, secret-bearing URLs, and unexpected cookies.

## Static artifacts and cleanup

- [ ] Build the demo with API, database, and SMS unavailable.
- [ ] Verify the demo uses public `wedding-features` exports without deep imports or copied business logic.
- [ ] Scan generated files for fixture group/member data, messages, phones, RSVP states, bearers, PINs, receipts, provider values, and credentials.
- [ ] Store sanitized screenshots and notes outside public artifacts; record exact commands and revision in `docs/block5Validation.md`.
- [ ] Remove only this run's fixtures and sessions from the verified test target. Preserve sentinel and pre-existing data.
- [ ] Rerun every affected QA item after a defect correction before marking it passed.

## Listening

The checklist uses the application as the observable boundary while reserving transaction and concurrency proof for real PostgreSQL tests. It treats downloads as user-visible flows, including proxy headers and opening/printing the resulting files. Manual PIN remains the normal MVP identity route; SMS simulation exists only to verify accounting and cannot satisfy a live-provider gate.
