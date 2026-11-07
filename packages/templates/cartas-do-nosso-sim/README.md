# `@entrelacos/template-cartas-do-nosso-sim`

Independent paper-and-wine wedding presentation. Import reusable components and serializable content contracts from `@entrelacos/template-cartas-do-nosso-sim/v1`; import the matching `theme.css` in the host Tailwind entry.

The package owns WeddingLayout, LetterComposition, ScheduleSection, VenueSection, GiftSection, its colors, scrolling, navigation, reveal motion and validators. It imports no other visual template. The host supplies all couple content, photos, route ownership, environment configuration and operational React islands.

LetterContent accepts two or three image photographs, allows omitted cover/story transitions, and rejects duplicate section/generated-heading IDs. The story title serves as the letter salutation. Its salutation, prose and signature use the self-hosted Caveat Medium Latin font (50 KiB, including Portuguese accents); navigation and practical information retain their existing typefaces. The font comes from Google Fonts and is distributed under the SIL Open Font License in `src/assets/Caveat-OFL.txt`. `font-display: swap` and a local cursive fallback keep the letter readable while loading. VenueSection renders a compact card with a level-three heading, intended below the host's shared venue heading. The showcase at `apps/wedding-demo-cartas` intentionally supplies exactly two photos. Reduced motion, missing observers and failed animation measurement retain visible, usable content.

## Listening

Some rendering and validation code was copied during extraction to preserve both existing designs while allowing independent evolution. A third visual base package was deliberately avoided: confirmation, gifts and messages share wedding-features; primitive UI shares ui; operational API shapes share contracts. Future sharing should require demonstrated duplication that deserves coupled releases.

The editorial refinement removes repeated introductions instead of replacing them with new slogans. Optional transitions preserve compatibility for other template consumers. A single local handwriting weight keeps the letter personal without adding a font service or changing form readability.
