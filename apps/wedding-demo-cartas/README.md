# `@entrelacos/wedding-demo-cartas`

Marina and Caio's illustrative Cartas do Nosso Sim showcase, served at its own root. It consumes only `@entrelacos/template-cartas-do-nosso-sim/v1`, ui and wedding-features. Host-owned photos and content remain here.

Run `bun run --cwd apps/wedding-demo-cartas dev --port 4322`, `typecheck`, or `build`. Wrangler publishes independent `demo-cartas` and `demo-cartas-dev` static Workers.

Public build configuration: APP_ENV, PUBLIC_API_URL, PUBLIC_ADMIN_ORIGIN, PUBLIC_SITE_ID=demo-wedding-cartas, PUBLIC_SITE_URL and PUBLIC_BOTANICAL_DEMO_URL. Register each exact origin for this site before guest API calls. No server credential belongs in this app. Local dev has isolated site defaults; a production build never fills localhost values automatically.

The database population procedure is documented in docs/showcaseOperations.md. Illustrative mural authors include “exemplo”; no fictional content is a customer testimonial. Receiving approval remains independent, and no financial credentials or provider evidence are copied from the Botanical wedding.
