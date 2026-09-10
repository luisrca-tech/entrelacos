# EntreLaços engineering instructions

Read `plans/entrelacos-prd.md`, the implementation plan in `plans/`, `docs/decisionRegister.md` and `docs/architecture.md` before domain work. If filenames differ, follow the root README. Historical references do not override accepted interview decisions. Current state is scaffold only; never report a planned feature as implemented.

## Boundaries

- English code, comments and documentation; Portuguese product copy and user communication.
- Bun workspace with Node.js 24. Preserve lockfile and unrelated work.
- Only the API and authorized server-side operations access `packages/database`; browser apps consume public contracts.
- No gifts, payments, CMS, uploads, automatic infrastructure management or public account signup.
- Use shared template composition; do not fork/copy whole templates into wedding applications.
- No real secrets in source, public configuration, logs or fixtures. Do not deploy, mutate main, commit or push without session authorization.
- TDD for logic: focused failing test, minimal implementation, relevant passing tests. Real integration tests use explicitly disposable Neon resources, never development/main.
- Preserve tenant scope in reads, writes, exports, seeds and relationships. Admin message edits are forbidden; deletion and manual block are separate.
- For browser validation use the installed agent-browser skill. Verify responsive, reduced-motion and keyboard states against approved references before claiming visual completion.
- Use Graphify for structural navigation; direct reads verify correctness-critical claims. Keep `graphify-out/` and `.codex/hooks.json` ignored, never staged.
- Run `graphify update .` near completion after source changes. For semantic docs updates follow the installed Graphify skill.
- Documentation and task preflight must identify required credentials, provider setup, unresolved decisions and evidence before live integrations begin.

## Validation

Run `bun run check` for the scaffold. As business slices land, add integration/browser commands that fail clearly when required prerequisites are absent; never silently count skipped database tests as passing. Production migrations and deployment remain manual. A passing liveness endpoint does not demonstrate database readiness or authentication security.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
