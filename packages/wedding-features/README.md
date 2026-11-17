# `@entrelacos/wedding-features`

Shared wedding UI. `AdminRecognition` connects the public static site to the
central panel using a challenge-bound, one-use handoff. Its short-lived token
recognizes the assigned administrative session; it cannot read administrative
business data or become guest identity. Polling does not extend session life.

`FeatureAvailability` remains the presentation status surface for guest
features, including Motion and reduced-motion support. The package owns the
shared full-name-and-phone lookup, six-digit PIN confirmation, family session,
RSVP, and message presentation used by wedding sites. It does not send SMS or
integrate with a messaging provider.

## Money gifts switch

`GiftRegistry` lists gifts but keeps checkout off unless the site is built with
`PUBLIC_GIFT_PAYMENTS_ENABLED=true` (read through `giftPaymentsEnabled` in
`@entrelacos/ui`). While off, the purchase button stays visible but disabled
with a short "coming soon" note, and a checkout attempt saved in the browser is
neither resumed nor discarded. The admin panel reads the same variable to hide
its receiving area. The API is unaffected.
