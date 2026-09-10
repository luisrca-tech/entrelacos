# `@entrelacos/template-root`

Owns the reusable public wedding-site frame: document metadata, header/footer structure, page slot, section rhythm, and provisional editorial styling. `WeddingLayout.astro` and `TemplateSection.astro` are consumed directly by each wedding app.

This package does not own wedding content, media, authentication, RSVP behavior, admin workflows, or data contracts. A site composes those concerns around the layout in its own app.
