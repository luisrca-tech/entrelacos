# Internal gifts: production operation

Updated: 2026-10-24 (America/Sao_Paulo).
Release branch: `release-gift-payment`. Protected UI baseline: `bbf24a0`.

## Authorized scope and current status

The current user authorization covers production configuration, migration, merge to `main`, deployment, and supervised real payment and withdrawal acceptance. It supersedes historical production deferral in `internalGiftsSandboxOperation.md`; the earlier evidence remains unchanged.

The user explicitly selected the existing production `demo-wedding` as the public showcase with real integrated functionality and designated themselves as recipient. Preserve `is_demo=true`, the existing wedding presentation, and the latest Sonner UI. Do not use fictional financial identities, Sandbox credentials, simulated approval, or Sandbox payment-confirmation endpoints in production.

The authorized pilot is one R$10.00 Pix gift payment followed by one withdrawal with a maximum R$3.00 debit to the user's own reviewed Pix destination. The recipient enters identity information and the destination through the production panel. Amount authorization does not replace the original holder consent, recent password confirmation, or the specific frozen withdrawal preview.

Production schema migration is complete: all 23 journal hashes match the repository, the existing site count was preserved, and receiving accounts, ledger entries and financial operations remained zero immediately after migration. The release regression passed 8,078 tests across 292 files; lint, all workspace typechecks and production frontend builds passed. PostgreSQL integration passed 120 tests in the initial run, followed by all five tests in the two affected files after source stabilization and a deterministic guest-order fixture correction. PR #34 merged as `dca3574a8f86b8971cfdab19e162e18dbbcf6af4`, its main CI passed, and the API, panel and public showcase were published. Real onboarding and financial acceptance remain pending.

Independent read-only production QA confirmed private BFF responses use `no-store`, signed-out requests and wrong origins are denied, payment/security callbacks refuse unauthenticated requests, and the visible showcase contains no Sandbox or no-real-charge notice. It also reproduced a legacy lifecycle defect twice: the active showcase has no term and its owner menu offers no approval path. Focused failing regressions preceded the repair; 22 focused unit tests and seven isolated TEST PostgreSQL cases then passed. The repair still requires publication and an explicit owner approval in production. Receiving remains unconfigured and the public catalog truthfully returns `RECEIVING_NOT_READY`.

The native parent-account fee endpoint reports `childAccount.creationFeeValue=12.90`. This creation cost is separate from the authorized R$10.00 gift and maximum R$3.00 withdrawal. Obtain the user's specific decision before provisioning the first production receiving subaccount; do not infer consent to this fee from the pilot amounts.

## Verified targets and recovery

- Railway project: `44331440-5fa9-47bd-8f19-ee90fd8415ad`; production environment: `2669a65c-4be3-4df5-bdec-48a24f819515`; API service: `33e8bf5c-3a52-4b3b-8a12-483a7d6ce19e`.
- API: `https://entrelacosapi-production.up.railway.app`.
- Panel: `https://admin.entrelacos.workers.dev`.
- Showcase: `https://demo.entrelacos.workers.dev`.
- Cloudflare Workers belong to the EntreLaços account. Existing production versions were pinned privately before mutation.
- Railway uses the repository root, Bun 1.3.14, Node 24, API-only build/start commands, `/v1/health`, and `main` auto-deploy with Wait for CI enabled. Health proves liveness only.

Production database identity was checked against the explicitly selected commented production URLs. DEV, TEST and production have distinct Neon endpoints and branches. The affected TEST and production role passwords were rotated and their updated local connection strings were revalidated. Automated destructive database suites use only TEST and independently verified branch/project/database/user metadata.

Before schema changes, a PostgreSQL 18.6 custom-format archive was created with a repeatable-read snapshot. Its SHA256 is `c485e108427629b051cc7090668f8efdb027ccbebbb9432e91c75830c4aa088d`. An isolated local restore matched all row counts, data digests, migration hashes, and logical schema, including constraints, indexes, triggers, functions and enums. Physical column ordinal gaps left by historical dropped columns were normalized only for comparison. Migrations 0012–0022 succeeded on that restored database, preserved the original rows, and replayed without another effect. Local disposable clusters were stopped and removed.

Private archives, configuration snapshots and sanitized evidence are retained under `/home/lfrca/.local/state/entrelacos/production-release-20261024/` with restricted permissions. Recovery Git branches preserve the original `bbf24a0` release and `862d9ec` main. This proves recovery of this checkpoint; it does not establish continuous provider retention, PITR, RPO or RTO guarantees.

Rollback uses the pinned application artifacts with the rotated database credential and a compatible forward schema. Never restore this checkpoint over subsequently accepted payments or transfers: provider operations survive a database rewind. Stop new financial commands, retain incoming events and immutable observations, and reconcile or repair forward.

## Production configuration

Production secrets are assembled from their explicit private source sections and injected into the selected production service. Local active DEV/Sandbox configuration remains unchanged. Preserve existing authentication and guest fingerprint secrets, and keep the production account-credential key stable.

`ASAAS_LIVE_DEMO_SITE_ID=demo-wedding` is a private, exact-site opt-in accepted only with `ASAAS_MODE=live` and `APP_ENV=production`. It permits real provider-backed flows for this showcase without changing its demo identity or authorizing other demo sites. It grants no receiving or withdrawal permission to an actor. All native account, holder, consent, session, destination, environment and immutable evidence checks remain in force. Removing the opt-in blocks new operations; it does not erase history.

The frontend build uses explicit `APP_ENV=production` and `PUBLIC_LIVE_DEMO_SITE_ID=demo-wedding`. Production is never inferred from an absent, test or unknown application environment. The public client rejects Sandbox responses for this live showcase. Sandbox/no-real-charge copy requires both development and Sandbox; no production toast or page may claim that real charges are simulated.

The demo reset and reprovisioning paths reject the configured showcase and also reject persisted live holder/account custody even after the flag is removed. They cannot seed synthetic operational data over the real showcase.

Production gift images use the existing production R2 bucket through the stable API HTTPS origin. The current prepared `r2.dev` origin remains disallowed in production. Public delivery accepts only canonical `gifts/<site>/<asset>/<processing>.webp` derivatives, supports GET/HEAD and ETag, and limits reads and concurrency through the existing storage/lifecycle. This uses Railway bandwidth; a separate CDN delivery origin can be introduced if measured traffic warrants it.

Payment notifications use `/v1/webhooks/asaas`. Security authorization uses `/v1/webhooks/asaas/withdrawal-authorization` with its own independent secret. Register the account-bound payment webhook using [the explicit webhook operation](../docs/asaasWebhookOperation.md); an uncertain registration must reconcile the saved state instead of creating another webhook. Verify the exact scope of root-account security inheritance before changing provider settings. Do not enable unrelated critical-action or split approval modes to bypass the integration.

## Required production acceptance

1. Publish the reviewed release and verify the deployed revision, HTTPS origins, strict sessions/CSRF, catalog, media and worker lifecycle. Keep the existing showcase UI intact.
2. Through the authenticated production owner flow, establish a current site term and designate the user-controlled active site administrator as receiving holder. Existing `ACTIVE/PUBLISHED` state alone does not satisfy catalog term eligibility.
3. Have the holder complete real account registration, consent and any provider activation, documentation or proof-of-life requirements. Verify the new native subaccount, wallet, approved status, active receiving Pix key and exact original registration fingerprint. The external withdrawal destination is a separate reviewed key.
4. Configure and verify the payment and security callbacks against the stable production API. A callback acknowledgment is not settlement or approval evidence.
5. Publish the R$10.00 gift. The guest total must equal its configured price; the 2% platform commission and actual provider fees reduce recipient proceeds. Pricing estimates do not establish actual settlement fees.
6. Have the user pay once through the genuine hosted Pix checkout. Prove an authenticated provider event, canonical native payment, received terminal status, exact split/actual fees and exactly one recipient ledger credit. Card confirmation alone never creates available credit.
7. Let the holder review and confirm one withdrawal with at most R$3.00 debit. Live consent states the maximum debit, maximum fee and minimum net. A lower actual fee increases the recipient net; historical Sandbox fixed-net consent remains unchanged.
8. Prove one immutable matching security approval, one native transfer, terminal provider completion, actual debit/fee/net, one local debit, consumed/released reserve and no duplicate attempt or financial effect. Recovery may query the original operation and must never retry an uncertain financial POST.
9. Verify the visible production site and panel contain no Sandbox or no-real-charge notice. Confirm durable status rather than relying on a toast.

FAILED/CANCELLED transfer reserve release currently requires immutable native evidence of zero effective fee. A residual or unproven fee remains UNKNOWN/HELD for reconciliation. Refund/dispute observations retain a safety hold; automated compensating ledger effects are not established. These limits must remain explicit in operational launch decisions and must not be described as fully automated recovery.

The main production account was observed as CNPJ/MEI with approved commercial information, documentation and general status; its bank-account status remained pending. Its own fee schedule is not the future recipient subaccount's fee schedule. Actual onboarding and account eligibility must be observed before acceptance. The provider's [subaccount requirements](https://docs.asaas.com/docs/criacao-de-subcontas) and [evaluation limits](https://docs.asaas.com/docs/faq-periodo-de-avaliacao) govern the live operation; real-money testing does not imply unrestricted provider approval.

Historical open legal, media-rights, support, retention and continuous recovery decisions in `docs/block7LaunchGates.md` remain separate from technical and financial acceptance. Do not turn a successful deploy into a claim that those decisions were completed.

## Listening

The pre-existing active showcase lacked a term because it predates the owner approval lifecycle. Approval now permits an active site only when its term is missing, through the same explicit OWNER action and confirmation used by review approval. It creates the term under the existing site lock while preserving publication, demo identity and existing data. Repeated or concurrent approval preserves the first term, including an expired term; it never silently renews it. Deactivating the showcase, inserting a fixture term directly or weakening public eligibility was rejected. Production QA must verify the repaired action and the ordinary approval result after deployment.

The user selected the existing production showcase instead of a separate pilot site. An exact-site live opt-in preserves its identity and presentation while retaining real financial authority and permanently protecting live custody from reset. Renaming the demo marker, enabling all demo sites or allowing simulated evidence in live was rejected.

Live withdrawal consent uses a minimum net because the provider documents net value after its transfer fee. Assuming a permanent fee waiver or promising a fixed net from a maximum estimate would misstate the recipient outcome. The ledger records authoritative actual settlement separately from immutable consent.

The production R2 preparation used a development-only public hostname and no custom domain exists in the account. Reusing the established API and storage boundaries avoids weakening the hostname policy or creating another application solely for delivery. The private checkpoint and restore rehearsal precede migration, and the production publication remains subject to the final integrated checks and supervised native acceptance.
