# Scaffold validation

Validated locally on 2026-09-10 for completion of the approved Block 1 scaffold boundary. This report covers runnable repository boundaries, not product acceptance. The validation used Bun 1.3.14 and Node.js 24.20.0. Logs, JSON assertions and screenshots are retained under ignored `work/block-1/`.

| Check | Result |
| --- | --- |
| Frozen Bun installation | Passed; `bun install --frozen-lockfile` reported no changes. The pre-run SHA-256 for `bun.lock` is recorded in `work/block-1/lock-before.txt` (`7be0aa9ca80d1e1cd029a0cc256a6dde7c69cfd7e49ef93b2a7fa2a71c4c4f05`). |
| `bun run lint` | Passed; Biome checked 52 files and applied no fixes. |
| `bun run typecheck --force` | Passed; seven tasks successful, zero cached, and Astro reported zero errors, warnings or hints. |
| `bun run test` | Passed; one Vitest file with four deterministic API tests. |
| `bun run build --force` | Passed; three tasks successful and zero cached for the API, admin panel and static wedding demo. |
| Compiled API HTTP smoke | Passed in a clean environment with only the required `PATH`; default port `8080` and `PORT=18080` override both returned the expected liveness behavior. |
| Admin browser smoke | Passed at `localhost:3000` from home to login and back at `1440x900` and `390x844`; login controls remain disabled, there is no horizontal overflow, and page-error logs are empty. |
| Demo browser smoke | Passed at `localhost:4321` at `1440x900` and `390x844`; `pt-BR`, all three navigation anchors, mobile reduced-motion behavior, no horizontal overflow and zero page errors were asserted. |

## Runtime and browser evidence

The compiled API smoke used `node work/block-1/httpSmoke.mjs`. `GET /v1/health` returned HTTP 200 with the expected raw `status` and `service` fields. The unimplemented owner route returned a structured 404 problem JSON response, and `POST /v1/health` returned 404. No database or provider credentials were supplied.

The admin smoke exercised home-to-login navigation and return navigation. Desktop and mobile JSON assertions cover viewport width, `scrollWidth`, route, disabled email/password/submit controls and page-error output. The demo smoke asserted the Brazilian Portuguese document, desktop and mobile anchor navigation for `#story`, `#details` and `#capabilities`, mobile `prefers-reduced-motion`, viewport width and page-error output. The corresponding screenshots were retained for review.

The completion pass aligned the API default with the documented `8080` port, aligned environment names without adding provider bindings, kept public copy in `pt-BR`, corrected a stale database-boundary comment, and made API tests assert raw JSON responses rather than schema-stripped values.

## Scope and limitations

No live database connection, schema migration, account activation, admin authentication, tenant authorization, SMS/provider call, RSVP, message moderation, export, provisioning, deployment, cross-origin authentication, recovery flow or finished visual/media acceptance was exercised. Those capabilities remain deferred. The admin login controls are intentionally unavailable, and the public demo remains a composition scaffold rather than the approved finished template. Final art direction, intro choreography, typography animation, original media, accessibility/performance acceptance and provider gates belong to later blocks.

This run made no commit, push or deployment. The repository has existing Git history and `origin/main`; CI is configured but remote CI did not run. No database, provider or external configuration was mutated.

## Local navigation index

Graphify code update completed and reported no topology changes. It warned that three Astro files had partial AST extraction; the passing Astro typecheck and build remain the direct evidence for those files. Semantic document refresh completed successfully and the ignored graph now includes the current documentation semantics. The ignored graph and machine-local hook configuration are navigation state, not product evidence and are excluded from version control.

## Historical package-manager context

The earlier package-manager migration moved all workspaces to Bun 1.3.14 and generated `bun.lock`. This completion report treats the current frozen install and validation logs above as evidence; migration cleanup details are historical context, not product acceptance.

## Listening

The minimal completion conclusion is selected because installation, static checks, compiled liveness and browser smoke all pass at the approved scaffold boundary. Rebuilding the skeleton would add no evidence and could obscure the deferred product gates. No new branching implementation was added in this completion pass, so this report makes no invented red-first test claim. Database, authentication, tenant isolation, SMS, recovery, cross-origin and finished visual capabilities remain deferred until their planned blocks provide real evidence.
