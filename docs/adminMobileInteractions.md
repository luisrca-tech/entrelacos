# Admin mobile interaction audit

## Scope

Reviewed payment history, gift catalog and editor, invitations, messages, team,
shared navigation, and representative dialogs using real React components with
local deterministic API fixtures. No production records were changed.

The reported symptom is a payment-filter tap activating **Atualizar lista** on
physical Android and iPhone devices. That exact retargeting was not reproduced
in Chromium touch emulation. This change fixes independently reproduced layout
and hit-area defects; physical-device confirmation remains necessary.

## Findings and changes

| Area | Reproduced problem | Change |
| --- | --- | --- |
| Payment history | 36px filter targets; filters and refresh compete for narrow space | At least 44px targets; mobile filter group occupies its own row and can wrap |
| Bottom navigation | Recebimentos label exceeds its own link with enlarged text | Constrain each grid track and label to its link |
| Bottom clearance | Wrapped navigation grows beyond the reserved 74px and covers the last action | Observe actual dock height, including safe-area padding, and reuse it in the gift editor footer |
| Gift catalog | Fixed four-column filters and nonwrapping card actions crowd narrow layouts | Responsive filter columns, 44px filter targets, wrapping card actions |
| Gift editor | Intrinsic grid widths and save labels overflow at 320px with enlarged text | Shrinkable single-column grids and wrapping save labels |
| Invitation overview | Summary table widens the entire page at 320px | Constrain grid tracks; scroll the table locally; allow summary action labels to wrap |
| Messages | Status badge and toggle widen the page with enlarged text | Constrain grids and allow badge/toggle text to wrap |

## Verification

- Chromium touch emulation at 320, 390, 430, and 760 CSS pixels, with root text
  sizes of 16px and 24px. The larger size is a stress test, not an exact model of
  Android or iOS accessibility text scaling.
- 5,760 hit-test samples across the five list screens, plus 882 in the gift
  editor and 1,080 in the invitation dialog: no unexpected intercepted targets
  or page-level horizontal overflow in the final runs. Samples cover a 3x3 grid
  within visible enabled controls; they do not certify every pixel or state.
- Native emulated touch on Todos, Pix, Cartão, and Atualizar lista verifies the
  intended click recipient. Filters do not issue a new server request.
- Opened/closed payment details, gift preview, team invitation, invitation form,
  account menu, and mobile More menu. Filled team fields and added an invitation
  guest without persisting data. Visually inspected mobile screenshots.
- A focused regression test failed before the dock observer implementation and
  passed afterward. It covers initial height, resize, and observer cleanup.
  Another test distinguishes local payment filtering from explicit refresh.
- Admin suite: 1,909 tests passed. After the final presentation changes, the
  affected gift-editor/message tests passed again (19 tests). Admin TypeScript
  and production build passed. Biome reported no errors and one pre-existing
  `GiftItem | void` warning.

## Listening

Keep the payment-row pseudo-element: its containing row intentionally provides
one row-wide action, and the browser audit did not show it escaping that row.
Do not introduce global propagation suppression or touch-event cancellation
without a reproduction; either could interfere with normal links and controls.

The local harness and screenshots live under ignored `work/admin-hit-targets/`
and `work/admin-dialog-qa/`. They are supporting session artifacts, not a new CI
browser-test dependency. Physical-device on-screen keyboards, Safari/WebKit behavior, network
mutations, all permissions, and all possible datasets were not certified here.
