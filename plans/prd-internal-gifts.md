# PRD: Internal Gifts and Couple Finance

Prepared on 2026-10-12; execution and recipient direction amended on 2026-10-14. Product scope comes from the approved Internal Gifts Asaas Release Plan and subsequent user decisions. Local implementation uses reviewed worktrees converging only into `release-gift-payment`; real-money/provider mutations still need concrete approval.

## Problem Statement

Couples need to configure symbolic wedding gifts in their site, receive Pix/card contributions safely, understand the money received and request transfers to their own bank. The platform owner needs an auditable commission without collecting and redistributing all customer funds. Couples also need operational assessors who can help without financial authority.

## Solution

Provide readiness-first receiving setup, a role-scoped gift catalog with Cloudflare R2 images, a public section matching the existing wedding template, hosted Asaas checkout and a private financial dashboard with customer-requested withdrawals. Target Asaas BaaS with individual recipient accounts and split of the platform commission. Keep bank-verification and commercial enablement pending until proven; continue local implementation through isolated provider adapters and explicitly labeled test fixtures.

## User Stories

1. US-01: As a platform owner, I want a separate verified Asaas operation, so that customer funds do not depend on my employer's account.
2. US-02: As a couple admin, I want to start receiving setup in the panel, so that I can prepare my site without opening a separate operational dashboard.
3. US-03: As a designated recipient, I want provider-controlled identity verification and clear consent, so that account ownership is established safely.
4. US-04: As a couple admin, I want to see pending and rejected receiving steps, so that I know what prevents activation.
5. US-05: As a recipient, I want to register a verified bank or Pix destination, so that withdrawals reach my account.
6. US-06: As a couple admin, I want gift configuration locked until receiving readiness is established, so that guests cannot contribute to an unready operation.
7. US-07: As a platform operator, I want missing/stale verification or a changed destination to invalidate readiness, so that old approval cannot authorize a new beneficiary.
8. US-08: As a couple admin, I want to invite and revoke site assessors, so that helpers receive only authorized operational access.
9. US-09: As an assessor, I want site-scoped access across assigned weddings, so that one client never grants authority over another.
10. US-10: As a recipient, I want assessors excluded from financial data and money movement, so that assistance does not expose my funds.
11. US-11: As a couple admin or assessor of a ready site, I want to create/edit/reorder/publish/archive symbolic gifts, so that the catalog reflects the couple's preferences.
12. US-12: As a catalog editor, I want fixed gift values and descriptions, so that guests understand the contribution.
13. US-13: As a catalog editor, I want safe image uploads and alt text, so that gifts remain attractive and accessible.
14. US-14: As a couple admin, I want catalog edits to appear without rebuilding the public site, so that administration stays practical.
15. US-15: As a guest, I want a gift section consistent with the wedding template, so that gifting feels part of the site.
16. US-16: As a guest, I want clear symbolic-gift disclosure, so that I do not expect physical delivery.
17. US-17: As a guest, I want to gift without invitation/RSVP login, so that payment is independent of attendance confirmation.
18. US-18: As a guest, I want to choose Pix or one-payment card and see itemized charges, so that I accept the final amount knowingly.
19. US-19: As a platform owner, I want an initial 2% commission on nominal gift value, so that the commercial proposal is explicit and testable.
20. US-20: As a couple, I want guest-paid processing and commission calculated correctly, so that quoted allocation is not underfunded by fees on the final total.
21. US-21: As a guest, I want provider-hosted card collection, so that card details do not pass through EntreLaços.
22. US-22: As a guest, I want truthful pending/success/expired/failed payment states, so that a return URL does not falsely claim receipt.
23. US-23: As a couple, I want separate receipts and available balance, so that authorization is not mistaken for withdrawable money.
24. US-24: As an authorized admin, I want private history with fees, commission, refunds and transfer status, so that transactions can be understood and reconciled.
25. US-25: As the designated recipient, I want to request a bank withdrawal through the panel, so that I control when available funds leave my Asaas account.
26. US-26: As the designated recipient, I want destination/amount/fees confirmed with recent authentication, so that money movement is deliberate and secure.
27. US-27: As a recipient, I want duplicate and concurrent withdrawal requests handled safely, so that retries cannot transfer twice or overdraw.
28. US-28: As a recipient, I want processing/authorization/failure/unknown withdrawal states, so that uncertain results are not hidden behind a success screen.
29. US-29: As a platform operator, I want durable authenticated event processing and reconciliation, so that retries, delays and restarts do not lose financial effects.
30. US-30: As a couple admin, I want a support path for refunds/disputes, so that problems are handled without assessor money access.
31. US-31: As an authorized support operator, I want audited refund controls and retained records, so that reversals remain traceable.
32. US-32: As a platform operator, I want financial history and recovery to survive site deactivation, so that disabling new gifts does not erase obligations.
33. US-33: As a mobile or keyboard user, I want accessible forms, focus and responsive layouts, so that receiving setup, gifting and withdrawals are usable.
34. US-34: As a demo visitor, I want labeled simulated/sandbox behavior, so that demonstrations never create live charges or readiness.
35. US-35: As a developer, I want to advance local contracts and UX while provider questions remain open, so that unanswered automated support does not block independent work.
36. US-36: As the release owner, I want integration, security and real-provider evidence separated, so that local test success does not imply live-money readiness.
37. US-37: As the release owner, I want an explicitly authorized real pilot with payment/split/withdrawal/refund evidence, so that broad activation follows proven funds movement.
38. US-38: As a wedding-site user, I want existing invitation, mural and template behavior preserved, so that the release does not regress current features.

## Implementation Decisions

- The reviewed source checkpoint is `2a33c1b326c3496db64e9c825b86b596c4949632`; implementation worktrees start from its coordination-only descendant `9777b823eacc66d93c58d3dd1eed78b3e0bd641e`. The principal integrates only into `release-gift-payment`. Exact branches, writers, grants and execution leases are recorded in `internalGiftsCoordination.md`; no integration into main/development, PR or deployment is authorized.
- Workstream A owns receiving readiness, the Asaas boundary, payment/commission/event processing, finance and withdrawals. Workstream B owns site access/assessor invitations, gifts/media/public presentation and guest checkout UX. Each slice closes schema/API/UI/tests through explicit cross-workstream handoffs.
- Preserve the Hono API, TanStack administrative application, static Astro public hosts, presentation-only template, reusable public runtime, PostgreSQL/Drizzle and Cloudflare/Railway topology.
- Site-scoped membership distinguishes platform owner, couple admin and assessor. Financial authority also requires a designated verified recipient; a role alone cannot select the beneficiary.
- The bride owns the wedding site and the individual receiving account. The bride or an authorized wedding planner may administer her site; administrator status never transfers receiving ownership or automatically grants withdrawals. Preserve the separate assessor role and authorized same-site historical access, including previous operators, without extending financial authority.
- BaaS is the confirmed target journey, not an enabled provider capability. Receiving setup precedes catalog/checkout, clearly identifies the bride as account holder, and requires her consent and the approved provider verification/disclosure flow. Do not create a receiving account as a side effect of guest checkout or silently substitute another account model.
- Catalog configuration, media upload, publication and checkout are gated by authoritative receiving readiness. Bank-verification evidence is separate from account approval; unknown status fails closed.
- Monetary values use integer cents. Immutable orders freeze item, recipient, method, policy and quote. Initial commission is 2% of nominal value, added with processing to the guest total; final live pricing remains pending.
- Hosted payment is method-restricted to the accepted quote. No invitation login is required. Provider events and reconciliation establish money states, not browser redirects.
- Individual provider accounts retain customer funds. The financial area presents provider-backed balances and customer-requested transfers, not a platform-custodied wallet.
- Durable intents, uniqueness, concurrency controls, encrypted credentials, authenticated events and audited privileged actions protect financial effects. Unknown external outcomes require reconciliation before retry.
- Safe R2 staging and validated immutable derivatives keep catalog media separate from identity documents.
- Provider-independent work may use injected test adapters and labeled demo fixtures; production cannot enable a fake adapter or simulated bank validation.

## Out of Scope

External gift lists, another gateway, installments, shopping carts, physical delivery, gift stock/quotas, arbitrary-value gifts, pooled platform funds, automatic withdrawals/anticipation, platform storage of identity documents, a general CMS and automatic live deployment. A one-cent verification transfer with assumed automatic reversal is not adopted.

## Further Notes

The provider's automated support did not answer. This is neither approval nor rejection. Continue local implementation of the confirmed product rules without waiting for support. Account-specific symbolic-gifts/PF/BaaS acceptance, bank-validation mechanism, contract fees and permitted fee disclosures, ongoing credential access, lost-response recovery, security/withdrawal approval, refunds/disputes/liability and accounting adequacy remain external gates. Missing evidence returns unavailable; synthetic acceptance never establishes production READY. The separate reviewed release-branch commit/push permission does not authorize provider resources, live money, migrations or deployment.

## Listening

The 2026-10-14 confirmation fixes the bride's receiving ownership and allows planner administration without financial-role inheritance. Implement these rules locally while retaining provider-dependent ports and explicit unavailable states. This rejects both waiting for support before useful local work and treating the chosen BaaS journey as already approved. Worktree isolation preserves, rather than replaces, exclusive ownership and execution leases.

The existing study is formalized into user outcomes without re-interviewing decisions already approved. Two feature-owning chats are preferred to isolated frontend/backend delivery: each phase has an end-to-end acceptance path, while shared-file ownership prevents concurrent editing collisions.
