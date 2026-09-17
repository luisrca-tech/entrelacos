# Block 7 launch-gate register

Status: technical review prepared; human, legal, provider, and recovery decisions remain open unless evidence below says otherwise.

Date: 2026-09-16

This is a technical gate register, not legal advice or a claim of LGPD compliance. An open item blocks only the corresponding launch claim unless the final go/no-go owner explicitly determines a broader impact.

| Subject | Status | Responsible human/legal owner | Decision date | Evidence | Next action | Launch consequence |
| --- | --- | --- | --- | --- | --- | --- |
| Privacy notice and lawful processing basis | OPEN | Unassigned | — | Technical data boundaries exist in repository contracts; no approved legal text was supplied | Assign privacy/legal reviewer and approve the notice, purposes, bases, recipients, and contact route | Blocks privacy-compliance and production-launch approval claims |
| Data-subject rights procedure | OPEN | Unassigned | — | Admin deletion/export behavior is technical evidence only | Define identity verification, request intake, response ownership, deadlines, exceptions, and audit evidence | Blocks claim that rights requests are operationally supported |
| Retention schedule | OPEN | Unassigned | — | No approved retention periods or exception policy were supplied | Approve periods by data category, deletion triggers, backup treatment, and legal exceptions | Blocks retention-compliance claim and final production data policy |
| Deletion procedure | OPEN | Unassigned | — | Tenant deletion behavior has automated coverage; legal exceptions and backup propagation are undecided | Reconcile technical deletion with approved retention and recovery policies, then assign the operator | Blocks complete deletion-policy claim |
| Client media permission | OPEN | Client owner and legal reviewer, unassigned | — | Block 6 explicitly limits approval to fictional demo media | Establish upload/license representation, approval record, removal path, and dispute procedure | Blocks use of real-client media |
| Demo media rights | LOCALLY APPROVED, EXTERNAL PROVENANCE OPEN | Project owner and media-rights reviewer, unassigned | 2026-09-14 local approval only | `docs/block6MediaRegister.md` records the fictional-demo delivery and its limits | Confirm source/model/provider/license records and permitted public/deployed use before release | Blocks external rights claim and public deployment of those assets until approved |
| Support ownership and service expectations | OPEN | Product/support owner, unassigned | — | No approved support channel, hours, escalation, or service level was supplied | Name the support owner and publish intake, escalation, incident, and response expectations | Blocks support-readiness claim |
| Third-party/provider use | OPEN | Product owner, privacy/legal reviewer, and infrastructure owner, unassigned | — | Local execution uses simulated/unavailable labels and does not prove provider approval | Approve providers, data flows, contracts, regions, credentials, failure policy, and costs | Blocks live provider use and corresponding production flows |
| External observability sink and retention | OPEN | Infrastructure and privacy owners, unassigned | — | Local structured allowlisted output is implemented; no external sink was selected | Select a sink, approve access and retention, validate redaction in that destination | Blocks claim of production monitoring readiness, not local structured logging |
| Recovery, RPO, and RTO | UNPROVEN | Infrastructure and release owners, unassigned | — | `docs/block7Recovery.md` records missing prerequisites; no real restore occurred | Execute the authorized isolated restore exercise and record observed metrics | Blocks recovery claim and production go/no-go dependent on recovery |
| Authentication and production secret operations | OPEN | Security/infrastructure owner, unassigned | — | Local test identities and secret-safe handling do not approve production credentials | Approve production identity lifecycle, secret storage, rotation, break-glass, and revocation | Blocks production authentication/security-readiness claim |
| Final go/no-go | OPEN | Named release owner, unassigned | — | Block 7 technical evidence is incomplete while the rows above remain open | Assign owner, review every required gate and exception, record a dated decision | Blocks final production launch approval |

## Technical boundaries already enforced

- Demo reset is OWNER-only, demo-marker-only, transactionally isolated, and does not require a live messaging provider.
- Operational logs use a strict allowlist and explicit `simulated`, `unavailable`, `manual`, and `live` labels.
- Static editorial builds do not require the API, database, SMS, or media-provider availability.
- CI database integration is conditional on explicit test-only configuration and does not migrate main or deploy production.

These controls reduce technical risk but do not settle the open human/legal decisions above.

## Listening

The register separates locally demonstrated controls from approvals that only named humans can provide. Demo-media acceptance remains narrower than a transferable rights determination, and safe local logs remain narrower than an approved production observability service.
