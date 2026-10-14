# Plan: Internal Gifts and Couple Finance

> Source PRD: Internal Gifts and Couple Finance, prepared 2026-10-12. The Internal Gifts Asaas Release Plan remains the detailed financial/security reference.

## Architectural decisions

- **Execution:** one shared branch from main; two feature workstreams A (receiving/payments/finance) and B (access/catalog/public experience). No separate branches/worktrees. Exclusive shared-file ownership and dated checkpoints are mandatory.
- **Routes:** authenticated operations stay under `/v1/sites/:siteId/`; public catalog/quote/checkout stay under `/v1/public/sites/:siteId/`; provider webhooks use a dedicated authenticated receiver. Exact verbs and schemas are frozen at the integration checkpoint, not guessed from provider APIs.
- **Schema:** site-scoped memberships/invitations, readiness evidence, verified destination versions, catalog/media, immutable gift-order/quote records, durable external-operation/event records, append-only financial entries and withdrawal intents.
- **Provider:** approved BaaS/subaccounts with PJ platform and verified individual recipients. Runtime modes are disabled, sandbox and live; production bank validation and provider enablement remain pending.
- **Authorization:** couple admins invite assessors; assessors never read private finances or move money. Financial changes require designated recipient authority, recent authentication and verified stored bindings.
- **Readiness:** catalog configuration/upload/publication and new checkout remain locked until receiving readiness. No cent-transfer shortcut or simulated production approval.
- **Money:** cents, versioned 2%-nominal initial commission, guest-paid processing, authoritative method-specific quote, exact supported split, distinct receipt/settlement/availability/withdrawal states.
- **UX:** receiving setup first; existing template tokens; anonymous guest checkout; private provider-backed finance/withdrawal screens; accessible mobile and cross-origin flows.
- **Validation:** TDD for logic; deterministic adapters for local evidence; disposable PostgreSQL tests; authenticated browser tests; sandbox and live evidence separately labeled.

## Phase 0: A real locked-state administrative seam

**User stories:** US-04, US-06, US-10, US-34, US-35, US-38.

### What to build

A authenticated readiness projection that defaults to not ready; B consumes it in the panel's locked Presentes entry with a safe receiving-setup action. Agree public-facing types and permissions early. Test direct API refusal as well as the UI. This is demoable without Asaas credentials and cannot unlock a live site.

### Acceptance criteria

- [ ] A publishes the first shared contract checkpoint and B acknowledges it.
- [ ] Unknown readiness blocks configuration/upload/publication/checkout, not unrelated invitation/mural sections.
- [ ] UI indicates pending setup; public guests and assessors see no private account data.
- [ ] No client payload, query flag or simulated adapter can mark production ready.

## Phase 1: Couple-managed assessor access

**User stories:** US-08, US-09, US-10, US-33, US-38.

### What to build

B delivers admin-issued assessor invitations, acceptance, revocation and a team UI, using A's serialized shared contract/schema edits. Site-scoped membership supports helpers with multiple assigned weddings and preserves platform-owner authority. Existing admins are not silently assigned beneficiary ownership.

### Acceptance criteria

- [ ] Couple admin can invite/revoke an assessor only within the site.
- [ ] Tokens are role/site bound, single-use, expiring and revocable.
- [ ] Assessor cannot promote/invite, access another wedding or read financial routes.
- [ ] Revocation invalidates stale sessions; existing invitation/mural flows regress cleanly.

## Phase 2: Recipient setup establishes receiving readiness

**User stories:** US-01 through US-07, US-33 through US-36.

### What to build

A delivers receiving setup, designated recipient binding, provider status and bank-validation boundary across persistence/API/UI. B connects navigation and the catalog lock to the published readiness service. Local tests simulate approved/pending/rejected transitions; real sites remain pending until provider-backed bank verification exists.

### Acceptance criteria

- [ ] Provider/account/environment/destination evidence is stored and audited, never accepted from the browser.
- [ ] Pending/rejected/stale evidence remains actionable and locked.
- [ ] A changed bank destination or relevant provider suspension invalidates READY.
- [ ] No first guest payment is needed to establish readiness; actual available balance is a separate withdrawal check.
- [ ] Provider commercial/bank-verification limitations remain explicit, even with passing local tests.

## Phase 3: A ready couple configures and publishes an imaged gift

**User stories:** US-11 through US-16, US-33, US-34, US-38.

### What to build

B delivers tenant-scoped catalog editing, safe R2 staging/finalization and a reusable runtime public gift section. A supplies the readiness check and serializes persistence/router/dependency registration. A ready sandbox fixture completes the full edit-to-public path without redeployment; every not-ready path stays blocked.

### Acceptance criteria

- [ ] Draft/edit/reorder/publish/archive works with fixed repeatable symbolic values.
- [ ] Invalid image bytes, size/dimensions, cross-site objects and reused/expired upload capabilities are rejected safely.
- [ ] Public cards preserve existing design, alt text and responsive behavior; identity documents never enter catalog storage.
- [ ] The API and public projection enforce eligibility independently of hidden buttons.

## Phase 4: A guest pays one symbolic gift and the couple sees a receipt

**User stories:** US-17 through US-24, US-29, US-33, US-34, US-36.

### What to build

B owns guest catalog/payment-method/itemized-quote/return UI and an authoritative catalog lookup; A owns immutable order/quote, hosted method-restricted checkout, exact commission split, durable events and receipt allocation. Complete the end-to-end path with local adapters, then authorized sandbox evidence when access exists.

### Acceptance criteria

- [ ] No invitation/RSVP login; gift price/recipient cannot be supplied authoritatively by the client.
- [ ] 2%-nominal proposal and guest-paid processing preserve quoted allocation with cent rounding and an explicit policy version.
- [ ] A method change requires a new quote; redirects never prove payment.
- [ ] Duplicate/out-of-order/early events and uncertain creation are reconciled without duplicated financial effects.
- [ ] Payer/card/provider secrets never appear in public builds or logs.

## Phase 5: The recipient sees spendable balance and requests a bank transfer

**User stories:** US-23 through US-29, US-33, US-36.

### What to build

A delivers the private Financeiro dashboard and withdrawal flow across provider-backed balances, durable intents, API authorization and UI. B wires the existing panel composition after A supplies reviewed exports. Show received/net/pending/available/committed/withdrawn amounts and truthful unknown availability.

### Acceptance criteria

- [ ] Only authorized admins see private history; only the designated verified recipient can request withdrawal.
- [ ] Recent authentication, verified destination version, available balance, fees and provider critical-action requirements are checked.
- [ ] Concurrent requests/repeated clicks/timeouts cannot cause overdraw or duplicate transfers; reservations are neither omitted nor subtracted twice.
- [ ] Accepted, awaiting authorization, processing and completed bank receipt are distinct.
- [ ] Failure/cancellation/UNKNOWN recovery, protected receipts and stale balance are exercised in API/UI tests.

## Phase 6: Recovery remains operational after payment or site failure

**User stories:** US-24, US-29 through US-32, US-36, US-38.

### What to build

A closes refunds/disputes, reconciliation and worker recovery; B closes relevant public/admin states and browser regression. Central coordination schedules serialized repository-wide validation and reviews independent financial/security findings.

### Acceptance criteria

- [ ] Refund execution is explicitly authorized/audited; monetary reversals and provider fees reconcile.
- [ ] Deactivation disables new gifts while history/events/support obligations survive.
- [ ] Worker restart, event backlog, credential failure, destination changes and ledger/balance divergence have tested recovery.
- [ ] Unit/HTTP, disposable database, authenticated browser, public builds and secret checks have actual evidence, not skipped-check claims.

## Phase 7: Explicitly authorized production pilot

**User stories:** US-36, US-37.

### What to build

Only after human/account-specific provider and accounting gates are settled, central coordination proposes a concrete consenting non-demo pilot. A traces real Pix/card/split/withdrawal/refund; B verifies user experience against those actual statuses. Do not begin automatically.

### Acceptance criteria

- [ ] PF/BaaS, fees, bank verification, credential operations and approval/security are documented for this account.
- [ ] User approves exact resources, amount budget, payment methods, recipient and refund plan.
- [ ] READY precedes catalog setup; a panel-requested withdrawal has actual bank receipt evidence.
- [ ] Delayed card settlement stays pending; rollout follows a recorded decision, not a local test result.

## Listening

The previous G0–G7 technical checklist is retained as a risk reference. These phases reorganize delivery into demoable end-to-end slices shared by two independent feature owners. Local work is not blocked by automated support, but bank-validation and production approvals cannot be substituted by mocks.
