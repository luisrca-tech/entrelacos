# Block 6 handoff

Status: the local public-template implementation, provisional demo presentation, independent black-box QA, post-fix revalidation, consolidated final gates, and independent diff review are complete for the exercised scope. All accepted review findings were corrected and revalidated. Final media acceptance remains pending. No commit, push, merge, deployment, provider call, or production action is included.

## Delivered local boundary

- `@entrelacos/template-root/v1` is the only public template entrypoint.
- `WeddingLayout` provides host-driven metadata, navigation/footer shells, named extension slots, the five-variable theme contract, and internal progressive interactions.
- `WeddingHome` provides the standard composition from the same public sections available for direct use.
- Hero, story, details, gallery, schedule/guidance, venue/map, footer, responsive navigation, reduced-motion fallbacks, and image/video poster behavior are available through serializable host data.
- `apps/wedding-demo` is the full default-preset consumer and composes the real `GuestAccess`, `MessageMural`, RSVP path, and recognized-admin return link through `wedding-features`.
- `apps/template-fixture` proves a distinct minimal host, reordered preset, local section, and extra `/hospedagem` page without copying template code.

The exact API, validation, slots, theme variables, motion, media, map, ownership, and privacy rules are frozen in `docs/block6Contracts.md`.

## Consumer rules

New or existing wedding hosts must:

1. import only from `@entrelacos/template-root/v1`;
2. own every route, visible string, label, identifier, SEO/indexing value, asset, alt text, map/fallback URL, feature configuration, and local section;
3. keep configuration serializable and pass it through the typed contracts;
4. compose runtime guest UI only through public `wedding-features` exports;
5. build useful editorial content without API/database/SMS/media-provider availability;
6. keep operational and secret data out of static content and artifacts;
7. use only `--template-ivory`, `--template-olive`, `--template-ink`, `--template-muted`, and `--template-line` as supported `/v1` theme tokens.

Do not copy the Marina & Caio or Casa Aurora content into the package or provisioning defaults. Neither host is a content source for another wedding.

## Current demo and fixture

The demo owns Marina & Caio, the September 2027 date, Casablanca Eventos address, Google Maps embed/directions URL, fallback venue link, navigation/SEO/footer copy, guest/mural placement, and seven provisional SVG assets. Demo SEO is `noindex, nofollow`.

The technical fixture owns Casa Aurora, its April 2028 event data, terracotta SVG, noindex metadata, story-before-hero order, local extension, and `/hospedagem` route. It intentionally contains no guest API, database, SMS, admin recognition, or product-polish requirement.

## Runtime feature boundary

`GuestAccess`, RSVP, and `MessageMural` continue to use the Block 3–5 session, origin, concurrency, deadline, moderation, and privacy contracts. Their data remains runtime-only. Template composition changes presentation and placement only.

`AdminRecognition` is a hydrated host feature, not navigation content. Public visitors receive no panel option. Only valid recognition displays `Modo administrador` and `Voltar ao painel`; an error may display feedback but no panel link. The API and authenticated admin handoff remain the authority.

The RSVP dialog uses native modal behavior, restores opener focus, and opts out of Lenis capture. The mobile menu uses native `details`/`summary` and remains navigable without JavaScript.

## Media and map status

The current demo uses abstract SVG placeholders and image media only. The template supports a later muted inline loop video with required poster and no autoplay dependency, but no video has been generated or approved. `docs/block6MediaRegister.md` is the source of truth for provisional assets and pending provider/rights/cost decisions.

The map is a host-supplied Google Maps iframe with no key, plus a visible address, directions link, venue-site fallback, and copy feedback. External rendering is not guaranteed by the static build and has no provider/legal approval claim.

## Final QA handoff

The independent run and focused rerun are recorded in `docs/block6QaChecklist.md` and `docs/block6Validation.md`. The rerun closed all five accepted public defects and disproved the earlier RSVP false positive with a POST 200 plus reload-persistence cycle. Authorized handoff, mural availability, and inactive/reactivated lifecycle also passed with state restored.

Three subscopes remain explicitly blocked rather than accepted: the root OWNER list against an unrelated invalid legacy test row, message publication without a verified reversible cleanup path, and the deadline/foreign/primary-group matrix not completed in the bounded rerun. Future execution must isolate or clean only owned fixtures, use `DATABASE_URL_TEST`, and must not reinterpret these blocks as product failures or passing evidence.

## Next-block boundary

Block 7 may add deterministic demo seed/reset and broader integrated quality/abuse/observability evidence. It must not turn `apps/template-fixture` into a permanent demo environment or move API authority into the template. Block 8 remains responsible for thin-host provisioning, exact release records, independent deployment, domain/origin work, rollback, lifecycle publication, and production approvals.

Provisioning must create host-owned content/configuration rather than cloning demo content or embedding any content default in `template-root`. Publication must record Git revision, lockfile/build inputs, contract major, canonical origin, artifact identity, and deployment identifier separately.

## Listening

The handoff treats the polished demo and technical fixture as different evidence surfaces: one demonstrates the default experience, while the other proves composition flexibility. Final media production stays outside this implementation because choosing a provider without rights, cost, and approval inputs would create a false launch claim. Independent black-box QA passed for the exercised scope; the three explicitly blocked subscopes remain future evidence work under the fixture-safety conditions recorded above.
