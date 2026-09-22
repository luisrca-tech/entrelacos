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
