# Public contracts

Shared strict TypeScript/Zod contracts for liveness, RFC problem responses,
sites, lifecycle, domains, controlled administrative access, current actors,
and cross-origin handoff. See `docs/block2Contracts.md` for the frozen Block 2
HTTP mapping. Database models, passwords, session cookies, and stored token
hashes are never response contracts.

The Node API bundles workspace source. Frontend bundlers consume source as well.
A package version of 0.0.0 does not replace `/v1` compatibility requirements for
already published client sites.
