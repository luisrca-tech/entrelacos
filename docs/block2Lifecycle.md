# Block 2 site lifecycle operations

The API records lifecycle, publication, domain, origin, and service-term state
separately. `DRAFT` sites move to `IN_REVIEW` and then to `ACTIVE` when an
owner approves review. Approval records the server clock and creates one
calendar-year term. February 29 starts end on February 28 in the following
year. Later approval calls are idempotent and never renew or reset an edited
term.

Deactivation preserves the site, term, domains, origins, and all operational
rows. It stores the previous non-inactive lifecycle and marks the site
`INACTIVE`; reactivation restores that lifecycle and keeps the existing term
and dates. Expiry is informational and never automatically deactivates or
deletes a site. Publication state is an independent record and does not claim
that a static host was deployed.

## Manual inactive publication procedure

When a site becomes inactive, the operator must manually deploy the neutral
placeholder to every public address:

1. Build the neutral placeholder from the approved static-hosting artifact
   with `PUBLIC_SITE_INACTIVE=true`.
2. Deploy it to the infrastructure-provided `workers.dev` address.
3. Deploy the same placeholder to every configured custom domain and verify
   the apex and `www`/redirect variants that DNS exposes.
4. Confirm HTTPS, the neutral response, and the absence of wedding content on
   each address.
5. Record the deployment and domain checks with the lifecycle change.

The API publication mutation records the operator's intended publication
state. It does not invoke a static host, DNS, or custom-domain provider. A
reactivation requires the normal operator deployment flow to restore public
content, followed by an explicit publication-state update.

## Listening

Lifecycle and publication remain separate because the API has no deployment
provider authority. Site-row locks plus database uniqueness keep concurrent
transitions, origin replacement, and primary-domain replacement atomic. The
implementation leaves expiry and static deployment manual; automatic expiry
actions would couple business dates to infrastructure state without an
approved provider operation.
