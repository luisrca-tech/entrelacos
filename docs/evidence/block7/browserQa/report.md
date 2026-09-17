# EntreLaços Block 7 Black-box Browser QA

## Verdict

Initial run was `BLOCKED` for protected OWNER/SITE_ADMIN and representative/family scenarios because the clean vault login did not establish a session. The post-fix rerun below is `PASS` for the public regressions and the controlled OWNER admin flows, with only SITE_ADMIN and representative/family/provider-delivery scenarios still `BLOCKED` for lack of a safe approved identity/secret setup. The independent executor did not modify product source; the orchestrator implemented the accepted fixes before the rerun.

## Run context

- Date: 2026-09-16, timezone `America/Sao_Paulo`
- Targets: admin `http://127.0.0.1:14173`, public demo `http://127.0.0.1:14328`, health `http://127.0.0.1:18080/v1/health`
- Browser: HeadlessChrome 149.0.0.0 via agent-browser
- Viewports: 1440x900, 768x1024, 390x844 (also initial 1280x577)
- Session: fresh named agent-browser sessions; no auth state files persisted
- Observability: browser-visible UI, browser-originated fetch, console/error surfaces, screenshots, and recordings only

## Scenario coverage

| Scenario | Result | Evidence / notes |
|---|---|---|
| API health | PASS | Same-origin browser fetch returned HTTP 200, JSON content type, and an `X-Request-Id` header. |
| Public demo load | PASS | `screenshots/public-desktop.png`; title and all main sections rendered. |
| Public editorial navigation | PASS | Header/footer anchors for História, Galeria, Programação, Local, Confirmação, and Mural present; anchor navigation updated the URL and scrolled. |
| Gallery open/next/close | PASS | `screenshots/gallery-modal.png`; keyboard Escape closed the gallery and focus returned to gallery content. |
| Venue links and copy address | PASS | Copy action displayed `Endereço copiado`; address remained visible. |
| Public invalid lookup | PASS | Safe dummy input produced the localized app alert `Informe o nome completo e um celular brasileiro válido.` |
| Mural disabled state / refresh | PASS | Disabled message remained visible; refresh showed a temporary disabled loading state and returned to the disabled state. |
| Responsive layout | PASS | `screenshots/public-1440x900.png`, `public-768x1024.png`, `public-390x844.png`; browser-reported document width equaled viewport width at all three sizes, with no horizontal overflow. |
| Mobile menu and keyboard navigation | PASS | `screenshots/mobile-menu-open.png`, `mobile-menu-open-keyboard.png`; menu opened and exposed all six links; gallery controls were keyboard reachable. |
| Reduced motion | PASS | `screenshots/issue-002-reduced-motion-intro.png`; reduced-motion media query removed the intro overlay. |
| Images/video/map | PASS | Browser DOM checks found loaded image natural widths, video ready state 4, and the map iframe present; no broken-image error observed. |
| Console errors | PASS | No application console errors observed on public/admin login surfaces; only Vite/React development informational messages. |
| Admin clean surface | PASS | `screenshots/admin-clean.png`; unauthenticated root visibly showed `Acesso negado.` |
| OWNER login / site list | BLOCKED | `/login` rendered, but vault login post-check remained on `/login`; browser form and password validity remained false. See blocker below. |
| OWNER reset route | BLOCKED | No authenticated OWNER context or visible reset control was available; no reset request was sent. |
| OWNER guest groups, RSVP administration, messages, mural toggle, lifecycle, quotas/rate limits, exports | BLOCKED | Requires OWNER session and controlled site access. |
| SITE_ADMIN activation and scope denial | BLOCKED | Requires a safe OWNER-driven activation/access path; unavailable without OWNER session. |
| Representative/family session, RSVP, message, provider simulation | BLOCKED | Safe secret/clipboard setup was unavailable without OWNER-issued simulation authorization. No PIN/OTP/provider value was read or exposed. |

## Reproducible issues

### ISSUE-001 — Full-screen intro overlay blocks all controls for several seconds

- Severity: P2 (major usability/accessibility risk during initial load)
- URL: `http://127.0.0.1:14328/`
- Reproduction: open the public page with normal motion at 390x844; immediately attempt to activate `Continuar` or another underlying control.
- Expected: controls are usable immediately, or the intro provides an accessible skip/close action.
- Actual: a full-screen `.template-home-intro` overlay is visible and has `pointer-events: auto`; the browser reports the target button is covered. The overlay remained present for approximately 5–6 seconds before being removed. The underlying page was not keyboard/mouse actionable during that interval.
- Retry: reproduced on two fresh navigations.
- Evidence: `screenshots/issue-002-intro-overlay.png`, `screenshots/issue-002-step-1.png`, `screenshots/issue-002-step-2.png`, `videos/issue-002-repro.webm`.
- Note: with `prefers-reduced-motion: reduce`, the overlay was absent and the page was immediately usable.

### ISSUE-002 — Empty required lookup uses English browser validation in Portuguese UI

- Severity: P3 (localization/UX inconsistency)
- URL: `http://127.0.0.1:14328/`
- Reproduction: after the intro finishes, leave `Nome completo` and `Celular brasileiro` empty and activate `Continuar`.
- Expected: required-field feedback is consistently localized in Portuguese or uses the app's accessible alert.
- Actual: native browser validation exposes the exact message `Please fill out this field.` for the first required input. The rest of the form and app-level invalid-input feedback are Portuguese.
- Retry: reproduced twice; browser `validationMessage` remained the same.
- Evidence: `screenshots/issue-005-step-1.png`, `screenshots/issue-005-step-2.png`, `screenshots/issue-005-step-3.png`, `videos/issue-005-repro.webm`.

## Protected-flow blocker

The clean `/login` surface loaded correctly (`screenshots/admin-login.png`). Running `auth login entrelacos-b7-owner` with explicit email/password selectors did not establish an authenticated browser state: the post-action browser check remained at `/login`, the form was invalid, and the password control remained invalid. No OWNER site list was exposed, so the controlled `Block 7 QA Demo` site, deterministic demo reset, and all protected scenarios could not be tested. No credentials, cookies, query values, tokens, PINs, OTPs, phone values, or private messages were included in this report or evidence.

## Cleanup and limitations

- Closed all agent-browser sessions.
- Created no QA-owned guests, groups, RSVPs, messages, or other product records.
- Did not call the reset route because authentication was unavailable; therefore deterministic baseline restoration could not be verified.
- Protected admin, SITE_ADMIN, and family/representative/provider scenarios remain untested pending a working approved vault login or an already-authenticated browser session.

## Post-fix rerun (2026-09-16)

### Rerun context

- Browser: HeadlessChrome 149.0.0.0 via agent-browser.
- OWNER session: existing named session `b7-authcheck`, already authenticated as OWNER; no auth state was persisted.
- Public session: fresh named session `b7-public-rerun-20260916`.
- Controlled site: `Block 7 QA Demo` at site id supplied for this run.
- Viewports used for regression checks: 390x844 public mobile and 1440x900 OWNER desktop.
- Evidence root: `rerun/screenshots/` and `rerun/videos/` below this report.

### Current scenario table

| Scenario | Result | Evidence / notes |
|---|---|---|
| Public intro skip (normal motion) | PASS | `rerun/screenshots/issue-001-before.png`, `issue-001-find-skip-after.png`. `Pular introdução` was exposed and activated immediately; overlay was removed, scroll returned to 0, and the hero was revealed. |
| Public reduced-motion intro | PASS | `rerun/screenshots/public-reduced-motion.png`. `prefers-reduced-motion: reduce` loaded without the intro overlay. |
| Public empty-submit localization | PASS | `rerun/screenshots/empty-submit-fixed-visible.png`, plus the two retry captures. Empty submit showed the application alert `Informe o nome completo e um celular brasileiro válido.`; no native validation bubble was user-visible. The DOM `validationMessage` property still reports the browser default when queried, but `noValidate` prevented that browser UI from surfacing. |
| OWNER root/site list | PASS | `rerun/screenshots/owner-sites-final.png`. After the normal async load, the controlled site was listed and opened without altering legacy records. |
| OWNER workspace and guest-group states | PASS | `rerun/screenshots/site-workspace-loaded.png`. Confirmed, declined, partial, pending, Brazilian primary, and foreign administrative-only groups were visible; foreign group correctly had no PIN/demo-access controls. |
| RSVP current/history and filters | PASS | `rerun/screenshots/rsvp-history.png`, `rsvp-filter-foreign-pending.png`. Current and history tabs loaded; group/status filtering narrowed the view and was restored to Todos. |
| RSVP deadline before/after | PASS (admin surface) | A controlled past deadline was saved through the browser UI, exposed a `Remover prazo` action, and was removed again. Guest-side expired-deadline behavior remains covered by the representative/family BLOCKED scenario. |
| CSV/PDF exports | PASS | Both `Baixar CSV` and `Baixar PDF` controls were activated with the phone column left off; browser actions completed without UI errors. Controls are captured in `rerun/screenshots/exports-controls.png`. Download contents were not opened. |
| Mural enabled/disabled and per-group moderation | PASS | Mural was enabled and restored; Pending Family send permission was blocked and unblocked. `rerun/screenshots/mural-enabled.png`, `mural-disabled-restored.png`. |
| Owner message removal | PASS | Existing controlled fixture message was removed only after the Portuguese confirmation dialog and restored by final reset. No message text was retained in evidence. |
| Lifecycle inactive/reactivation | PASS | `Inativar casamento` disabled the site-scoped controls and changed to `Reativar casamento`; reactivation restored them. `owner-lifecycle-inactive.png`, `owner-lifecycle-reactivated.png`. |
| Quota/rate-limit/provider labels | PASS (surface only) | OWNER workspace exposed `SMS real`, `Simulação`, and the quota control; UI reported real SMS as unconfigured and showed simulated reservations. No live provider delivery was claimed. |
| OWNER demo reset, repeatability | PASS | Same-origin browser fetch with the exact `datasetVersion` body returned HTTP 200/OK and `Cache-Control: no-store` on four executions (including the final cleanup reset). The BFF initially omitted `X-Request-Id`; after the focused propagation fix, a fresh same-origin browser fetch confirmed status 200 and a present request ID. `owner-after-reset-1.png`, `owner-after-reset-2.png`, `owner-after-reset-3.png`, `owner-baseline-final.png`, `public-baseline-after-reset-1.png`. Final baseline showed active lifecycle, mural disabled, fixture groups, and the fixture message control restored. |
| SITE_ADMIN activation/scope denial | BLOCKED | No safe owner-driven activation/access path was available that would avoid exposing one-time credentials or tokens; no SITE_ADMIN identity was created or used. |
| Representative/family session, RSVP, message, mural, provider simulation | BLOCKED | No safe one-time PIN/clipboard setup was available for this rerun. PIN/demo controls were not opened, and no PIN, OTP, phone, token, or private message value was read. Live provider delivery remains unverified. |

### Rerun issue status

- ISSUE-001 is resolved in the tested build: the intro exposes an immediately actionable skip control, and reduced motion still bypasses the intro.
- ISSUE-002 is resolved for user-visible behavior: empty submit now shows the Portuguese application alert instead of surfacing the English browser validation bubble.
- No new reproducible product issue was found during the rerun. Browser error logs were empty for both rerun sessions; only expected development informational output was observed earlier.
- A focused post-rerun check confirmed that the admin BFF now preserves the API's safe `X-Request-Id` response header.

### Rerun cleanup and limitations

- Final OWNER reset was executed after all reversible checks. The controlled site returned to its deterministic baseline and the root list still contained `Block 7 QA Demo`.
- No QA-owned product records were retained, no legacy records were mutated, and no auth-state files were written to the repository.
- CSV/PDF downloads were not opened to avoid exposing guest contact data.
- SITE_ADMIN and representative/family/provider-delivery scenarios remain explicitly blocked pending a safe approved fixture/identity path.
