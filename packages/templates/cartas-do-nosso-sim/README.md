# `@entrelacos/template-cartas-do-nosso-sim`

Independent paper-and-wine wedding presentation. Import reusable components and serializable content contracts from `@entrelacos/template-cartas-do-nosso-sim/v1`; import the matching `theme.css` in the host Tailwind entry.

The package owns WeddingLayout, LetterComposition, ScheduleSection, VenueSection, GiftSection, its colors, native scrolling, navigation, reveal motion and validators. It imports no other visual template and has no Lenis dependency. The host supplies all couple content, photos, route ownership, environment configuration and operational React islands.

LetterContent accepts two or three image photographs and rejects duplicate section/generated-heading IDs. The showcase at `apps/wedding-demo-cartas` intentionally supplies exactly two photos. Reduced motion, missing observers and failed animation measurement retain visible, usable content.

## Listening

Some rendering and validation code was copied during extraction to preserve both existing designs while allowing independent evolution. A third visual base package was deliberately avoided: confirmation, gifts and messages share wedding-features; primitive UI shares ui; operational API shapes share contracts. Future sharing should require demonstrated duplication that deserves coupled releases.
