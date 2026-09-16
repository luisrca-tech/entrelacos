# Block 7 Load Report

Status: completed
Generated: 2026-09-16T22:20:51.585Z
Database target: `test` only; connection identity was verified before seed.
HTTP target: http://127.0.0.1:18080

## Environment and resources

- Runtime: v24.3.0 on linux
- CPUs: 16; host memory: 15.62 GiB
- API harness: `APP_ENV=test`, `SMS_MODE=simulated`, `TRUST_PROXY_HEADERS=true` on the local server only; synthetic loopback origins and client IPs were used for tenant/rate-limit separation
- Fixture marker: unique `block7-load-*` QA-owned prefix; `isDemo=false`; no demo, legacy, or production identifiers were selected
- Synthetic SMS quota: 1,000,000 per fixture tenant, preventing quota configuration from masking lookup/rate-limit behavior; no provider call is made
- Provider boundary: local manual/simulation behavior only; no Twilio or live provider calls

## Shape and seed

- Exact shape: 20 active tenants x 500 guests = 10000 guests
- Seeded rows: 20 sites, 10000 guest groups, 10000 guest members
- Guest modeling: 10,000 groups with one member each is intentional, so every synthetic guest has an independent group identity and public lookup/rate-limit scope.
- Group-shape coverage: this run intentionally used 10,000 one-member groups; couple, family, foreign, and other shapes were not exercised.
- Seed duration: 2753.75 ms

## HTTP stages

Traffic mixed real local routes: 30% `GET /v1/health`, 20% public mural reads at `GET /v1/public/sites/:siteId/mural`, and 50% public guest challenge starts at `POST /v1/public/sites/:siteId/guest/challenge`. Challenge requests intentionally reuse deterministic guests during burst traffic to exercise cooldown/rate-limit behavior. RSVP writes, message writes, and cross-tenant negative requests were not exercised; admin reads were not run because no safe local admin identity/session was available.

| Stage | Concurrency | Requests | Duration | p50 | p95 | p99 | HTTP errors | Timeouts | Rate limits (429) | Statuses | Problem codes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| steady-c5 | 5 | 500 | 23464.20 ms | 129.94 ms | 873.27 ms | 946.21 ms | 250 | 0 | 250 | 200:250, 429:250 | LOOKUP_RATE_LIMITED:150, OTP_SEND_RATE_LIMITED:100 |
| burst-c5 | 5 | 1000 | 17526.57 ms | 126.90 ms | 158.75 ms | 166.24 ms | 500 | 0 | 500 | 200:500, 429:500 | LOOKUP_RATE_LIMITED:500 |
| steady-c20 | 20 | 500 | 4725.63 ms | 229.28 ms | 313.43 ms | 353.82 ms | 250 | 0 | 250 | 200:250, 429:250 | LOOKUP_RATE_LIMITED:250 |
| burst-c20 | 20 | 1000 | 10025.33 ms | 245.27 ms | 482.70 ms | 533.48 ms | 500 | 0 | 500 | 200:500, 429:500 | LOOKUP_RATE_LIMITED:500 |

## Isolation evidence

- Before seed: 0 tenants, 0 groups, 0 guests (aggregate SHA-256 a8abf5024db76ddc158942179213ddee87e61ac0e912214c188ab1768365541a)
- After seed baseline: 20 tenants, 10000 groups, 10000 guests (aggregate SHA-256 a7b00d4adc28bcb0e1e0c28c21792c21a396752f2a0b52af9ef53c07f6652b53)
- After HTTP traffic: 20 tenants, 10000 groups, 10000 guests (aggregate SHA-256 a7b00d4adc28bcb0e1e0c28c21792c21a396752f2a0b52af9ef53c07f6652b53)
- Tenant snapshots unchanged after traffic: 20/20
- Snapshot hashes cover site identity/publication fields, group identity/phone fields, and guest identity/RSVP fields per tenant. The load runner did not update any fixture rows during HTTP stages.

## Cleanup evidence

- Cleanup ran in `finally` after the verified test connection: verified
- Remaining fixture sites: 0; groups: 0; guests: 0
- Remaining fixture guest rate-limit events: 0
- A verified preflight removed 300 orphaned rate-limit events from three controlled earlier `block7-load-run-*` executions; no `block7-load-*` rate-limit events remained before this run.
- Pre-existing orphaned runner rate-limit events removed: 0
- Cleanup scope was the exact generated site IDs, with database cascade for dependent fixture rows. Unrelated rows were not selected.

## Limitations

This is load evidence for the tested slice, not a complete Block 7 contract sign-off.

- Admin read traffic was not attempted because no local admin identity or session was established without storing credentials.
- Public mural and guest challenge traffic used configured local routes; simulated challenge delivery never contacted Twilio or another live provider.
- This is a load slice, not complete Block 7 contract evidence: RSVP writes, message publication/edit, family-session authentication, and cross-tenant negative requests were not exercised.
- The exact requested distribution is 10,000 one-member groups; couple, family, foreign, and other group shapes were not exercised in this load run.
- Evidence covers this exact 20-tenant by 500-guest fixture and measured request volumes only; it is not a future capacity guarantee.
