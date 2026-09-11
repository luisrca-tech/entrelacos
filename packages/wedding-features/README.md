# `@entrelacos/wedding-features`

Shared wedding UI. `AdminRecognition` connects the public static site to the
central panel using a challenge-bound, one-use handoff. Its short-lived token
recognizes the assigned administrative session; it cannot read administrative
business data or become guest identity. Polling does not extend session life.

`FeatureAvailability` remains the presentation status surface for later guest
features, including Motion and reduced-motion support. RSVP, guest OTP/sessions,
and messages are not implemented by this package yet.
