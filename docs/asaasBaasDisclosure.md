# Asaas BaaS disclosure

This presentation change adds the official Asaas seal, provider identification, and support information to receiving setup and financial pages, the receiving guide, the public gift quote, and payment recovery. It does not change payment creation, pricing, settlement, withdrawals, account settings, or legal agreements.

## Source and scope

Reviewed on 2026-11-09:
- [Customer playbook](https://asaas7379.zendesk.com/attachments/token/D8d5cbRPVEwnTCcALRHkeqWV6/?name=Playbook+de+BaaS+para+clientes+Asaas.pdf), extracted remotely.
- [BaaS subaccount documentation](https://docs.asaas.com/docs/cria%C3%A7%C3%A3o-de-subcontas-baas).
- The customer-specific seal URL retains ID `cf7ab943-556a-41e9-bb76-66a301ce446c`.

The shared `AsaasDisclosure` component uses the positive seal on a white surface, keeps its proportions, supplies alternative text, identifies the financial provider and technology integrator, and exposes the playbook's support email and telephone information. Its image sends an origin referrer; the external anchor uses `noopener noreferrer`. Text remains available if the remote image fails.

This is interface preparation, not regulatory approval. Contractual wording, communications outside these screens, hosted Asaas pages, and business-model eligibility still require the responsible parties' review.

## Validation and evidence checklist

The repository's pull-request workflow runs workspace validation, lint, type checking, tests, builds, public-build checks, and isolated PostgreSQL integration tests. It does not publish an application preview.

Before submitting the homologation form:
- [ ] Confirm all PR checks passed for the exact head commit.
- [ ] Open an existing authorized application preview at that commit.
- [ ] Check desktop and 360px mobile layouts, keyboard focus, text contrast, image loading, and absence of horizontal overflow.
- [ ] Capture the account/subaccount creation screen with the seal and its actual URL.
- [ ] Capture balance, payment history, withdrawal, receiving settings, quote, and recovery screens using an authorized test identity.
- [ ] Confirm the seal request includes the official ID and a referrer from the preview origin.
- [ ] Store genuine application screenshots with viewport, URL, and commit provenance; exclude account identifiers and other unnecessary personal data.
- [ ] Review legal documents and other financial communications separately with Asaas.

Do not create a financial account, submit a payment or withdrawal, enable anticipation, or fabricate screenshots to complete this checklist. No visual validation or screenshot is claimed by this document.

## Main-branch payment findings

Audited base: `121c957a3befd1b5de05d658695fb6060df81016`.

- The standard checkout payload uses `DETACHED` and rejects installment counts above one (`asaasCheckoutPayload.ts`). That restriction does not describe all payment paths.
- `asaasCheckoutClient.ts` has a separate `createInstallmentInvoice` path. For more than one installment it creates a customer and a credit-card payment, reads the installment schedule, validates amounts and split values, and returns the hosted invoice URL.
- `giftMoney.ts` constructs installment options from the supplied rate tiers and minimum installment amount. `sandboxDemoPricing.ts` also supplies observed live pricing: installment tiers are populated for `BUYER_GROSS_UP` when usable account fee data exists. Actual availability depends on the account, persisted pricing selection, and runtime eligibility; it was not exercised against production.
- The nominal platform commission policy is 200 basis points. The detached payload sends it as a fixed split; the installment path allocates commission across the payment schedule. No financial calculation was changed.
- `giftPaymentReconciliation.ts:isGiftReceiptEvent` recognizes `PAYMENT_RECEIVED` and `PAYMENT_SPLIT_DONE`, not `PAYMENT_ANTICIPATED`. This limited source audit does not establish end-to-end anticipation support.
- [Asaas anticipation guidance](https://docs.asaas.com/docs/split-em-cobrancas-antecipadas) requires validating fixed splits against the final net amount after anticipation fees and reconciling actual settlement. Anticipation and split divergence events need explicit verification before any activation.
- Parent-account eligibility, recipient PF eligibility, commercial restrictions for symbolic gifts, and current rates were not independently verified in this code task. Do not infer approval or subaccount capability from parent-account controls.

## Listening

- Preserve the user's Ubuntu checkout and active browser sessions: all repository operations use the connected GitHub account and remote resources.
- Reuse a single disclosure component instead of copying or redrawing the official artwork.
- Keep financial logic and legal agreements outside this presentation change.
- Use CI results as code evidence; retain visual validation as pending until a real authorized preview is available.
