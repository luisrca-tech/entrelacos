# Public contracts

Shared public TypeScript and Zod schemas. The scaffold contains liveness and generic error response shapes only. Add each versioned business contract with its implementation task and acceptance tests; do not export private database models or secrets here.

The Node API bundles workspace source for production. Frontend bundlers consume it as source. A package version of 0.0.0 does not replace `/v1` compatibility requirements for already published client sites.
