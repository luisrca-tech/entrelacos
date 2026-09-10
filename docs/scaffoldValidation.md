# Scaffold validation

Validated locally on 2026-09-09. This report covers the repository foundation, not product acceptance. Installation, lint, types, tests and builds were rerun after the Bun migration using Bun 1.3.14 and Node.js 24.20.0. Runtime HTTP and browser rows below are retained evidence from the earlier scaffold validation; they were not rerun for this package-manager change.

| Check | Result |
| --- | --- |
| Frozen Bun installation | Passed; root plus eight workspaces; `bun install --frozen-lockfile` made no changes to `bun.lock` |
| `bun run check` | Passed, exit code 0 |
| Biome | 52 supported files checked without changes |
| Type checking | Seven workspace tasks passed; Astro reported zero errors, warnings or hints |
| API tests | Three deterministic tests passed: health response, missing administrative route and unsupported health method |
| Application builds | API Node ESM, admin Workers client/server and static Astro demo passed |
| Runtime HTTP | Health returned 200; unimplemented administrative endpoint returned 404 |
| Admin browser smoke | Home-to-login navigation worked; placeholder fields and submit remain disabled; mobile view fits without horizontal overflow |
| Demo browser smoke | Navigation and section anchors available at mobile and desktop widths; mobile view fits without horizontal overflow; browser reported no page errors |

The API tests were first executed against the absent application module and failed, then passed after the minimal implementation. Local test/build logs and browser screenshots are kept under ignored `work/`; they are not production or CI evidence.

## Scope and limitations

No database connection, schema migration, account activation, admin authentication, tenant authorization, SMS, RSVP, message moderation, export, provisioning or deployment was exercised. Those integrations are not implemented. No provider keys were needed or written. The public demo is a composition scaffold, not the approved finished template: final art direction, intro choreography, typography animation, original media and complete accessibility/performance acceptance belong to their planned blocks.

The Git repository has no commit or remote publication from this delivery. CI configuration exists, but remote CI has not run. Recovery objectives and cross-domain credential handling still require the explicit validation gates in the PRD.

## Local navigation index

Graphify generated an ignored local navigation index and installed local hooks. The initial index reported external-import endpoint and duplicate-edge warnings; it is a navigation aid, not correctness evidence. The scaffold index had partial AST extraction for three Astro files and pending semantic document updates. The package-manager migration refreshes the local index, including changed documentation; source files remain authoritative. Its state is excluded from version control alongside the machine-local hook configuration.

## Listening

Checks target executable scaffold boundaries without inventing successful authentication or database behavior. Real integration acceptance will require explicitly disposable Neon resources and the credentials listed in each task preflight. Placeholder screens remain visibly unavailable until their product slices are implemented.

## Package-manager migration

- Removed all nine pre-existing top-level/workspace `node_modules` trees before reinstalling. Nested dependency directories were removed with their parent trees.
- Removed the old lockfile, workspace YAML and package-manager RC configuration; no `package-lock.json` was present outside those dependency trees. Bun recreated the dependency trees and generated `bun.lock`.
- Kept direct dependency versions unchanged. The clean resolution may select newer transitive versions within existing dependency ranges.
- `bun run check` passed with no Turbo cache hits: lint checked 52 files, all seven typecheck tasks passed, three API tests passed, and all three application builds passed.
- CI uses `oven-sh/setup-bun@v2` with the root manifest version and runs frozen installation followed by the same check command. Remote CI was not executed.
- No commit, push, deployment, database operation or external configuration change was performed.
