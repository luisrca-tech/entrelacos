# Admin dialog standard

The admin uses `AdminDialogContent` and `AdminAlertDialogContent` from
`apps/admin/src/components/AdminDialog.tsx`. Both reuse the existing Base UI
primitives from `@entrelacos/ui`; no additional dialog library is required.

## Responsive behavior

- Above 760px, dialogs are centered, normally up to 680px wide, with at least
  24px of vertical viewport clearance. Content-specific desktop widths remain
  available for exports, creation, and confirmation management.
- At 760px and below, dialogs fill the dynamic viewport, with no rounded corners,
  outer border, or page margin. Safe-area padding protects device cutouts.
- Content scrolls inside the dialog. The shared close control remains outside
  the scrolling body, with a 44px target. Invitation forms and exports own their
  scroll area and keep their action footer visible.
- Base UI owns the portal, background scroll lock, focus containment, Escape,
  and focus restoration. Alert dialogs retain explicit cancellation and existing
  destructive-action validation.
- Opening edit, delete, or confirmation management from invitation details closes
  the details first, so unrelated modal roots do not compete for focus.
- Payment-history retry actions are available inside the details dialog when a
  read fails, preserving the existing retained history and scoped reader.

## Inventory

| Area | Entry points | Change |
| --- | --- | --- |
| Invitations | `InvitationDetailDialog` | Inline side panel becomes a modal; list retains its full width. |
| Invitations | `InvitationFormDialog` | Create/edit right sheet becomes a centered dialog, full screen on mobile. |
| Invitations | `ManageConfirmationsDialog`, `InvitationExportDialog`, deadline in `InvitationsSection` | Shared frame, scroll behavior, close control, responsive sizing. |
| Invitations | `InvitationDeleteDialog` | Shared responsive alert frame; exact-name confirmation preserved. |
| Payments | `GiftPaymentHistoryView` | Inline side panel becomes a modal; full-width list and in-dialog retry. |
| Gifts | `GiftEditorView` | Preview and deletion use the shared frames. |
| Team | `SiteTeamView`, `SiteTeamSection` | Invitation and removal use the shared frames. |
| Messages | `MessagesSection` | Moderation confirmation uses the shared alert frame. |
| Weddings | `CreateWeddingDialog` | Creation flow uses the shared frame. |
| Settings | `SiteWorkspace` | Five editing dialogs and two destructive confirmations use the shared frames. |
| Financial security | `FinancialReauthenticationForm` | Password dialog uses the shared frame; controller guards remain unchanged. |

There are 21 dialog/alert entry points across 14 admin components. The obsolete
`AdminSidePanel` component and `adminStyles.dialog` styling have been removed.

## Listening

The request repeats “mobile” when contrasting the two layouts. The implemented
interpretation is centered on desktop and full screen on mobile, as stated at
the start of the task and illustrated by the provided admin screenshots.

Public-site dialogs were also mapped: the two template `GuidanceDetail`
components, Botanical `GalleryCarousel`, and wedding-feature `SiteDialog` /
`AdminRecognition`. They serve guest-facing experiences and retain their
existing presentation. Menus, filters, date pickers, and navigation remain
anchored controls rather than becoming full-screen dialogs.

## Validation

- Regression tests first reproduced the old sheet/inline-panel presentation.
- Interaction tests cover portal rendering, initial focus, Escape, focus return,
  detail-to-edit/delete/confirmation transitions, validation and save payloads,
  retained financial history, and retry from inside the payment modal.
- Local browser QA rendered the real admin components with deterministic API
  fixtures. Captures and measurements covered 1440×1000, 761×600, 760×420,
  390×844, and 320×568: centered/full-screen bounds, inner scrolling, no horizontal
  overflow, visible form actions, and close controls.
- The browser fixtures perform no real account or financial mutations. Physical
  mobile keyboards and production authentication are outside this local check.
