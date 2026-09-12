# EntreLaços Managed Wedding Websites — Product Requirements Document

**Status:** Accepted product scope consolidated from the 2026-09-09 interview; PRD draft pending user review. Architecture is documented separately; implementation remains unimplemented.

**Durable source:** Accepted interview dated 2026-09-09 and [the decision register](../docs/decisionRegister.md). Documents in `docs/references/` are historical context only. Where they differ, this PRD follows the accepted interview and register.

## Problem Statement

Couples and ceremony teams need a wedding website that feels personal, beautiful, and trustworthy while still handling practical guest work. Generic website builders make visual quality, invitation logic, RSVP collection, and guest support compete with one another. Self-service CMS products also transfer content production, publishing, access troubleshooting, and maintenance to people who are already organizing a wedding.

EntreLaços addresses this through a managed Brazilian service. An operator creates and maintains a custom public website for each wedding, and the couple or ceremony team receives a small operational panel for guests, RSVP, and messages. The service keeps visual production and publishing under operator control while giving the wedding team the data tools they need.

The product must remain clear about its boundaries. It is a managed service rather than a self-service CMS; a public wedding site is not an administrative account; guest verification is not a substitute for a guest account; and provider integrations, legal compliance, recovery objectives, and media licensing are not assumed merely because a screen or test double exists.

## Solution

EntreLaços provides one independently published, custom wedding website per wedding and one central administrative panel for the operator and authorized wedding administrators.

The operator creates the wedding site, composes its pages and sections, manages visual content in code and versioned assets, reviews the site with the client, and performs publication and maintenance. The reusable template owns presentation structure and defaults; each wedding app owns editorial content, media, SEO, routes and local extensions. Operators can add a page, reorder or replace a section, and reuse the common layout without copying the template or creating a self-service page builder. Shared guest behavior remains separate from editorial customization. The [2026-09-12 template/site study](./entrelacos-template-site-study.md) defines the planned implementation and acceptance details for Blocks 6–8. A `OWNER` can manage every wedding and every administrative access. A `SITE_ADMIN` can operate only the assigned wedding and can manage operational data without changing visual design, users, domains, or the service term.

Guests visit the public wedding URL. A representative of a family or group identifies the group with full name and registered Brazilian phone number and enters the persistent group PIN that the bride or planner shared with the invitation link. The representative receives a family-scoped session and can answer RSVP for each member and publish one group message when those features are enabled. Twilio Verify remains an optional future SMS channel, not an MVP dependency. The API remains responsible for authorization, tenant isolation, business rules, rate limits, and session invalidation.

The initial public experience is an editorial, cinematic wedding story with direct access to practical information. It can include a hero photo or a short muted hero video, couple story sections, a gallery, schedule, ceremony and reception information, directions, RSVP, a message mural, and responsive navigation. Motion supports the story but never delays authentication, forms, errors, confirmation, reading order, or reduced-motion access.

## Product Context and Service Model

### Customers and users

- The buyer is the couple or a designated ceremony team, with the exact commercial decision still external to this product document.
- The primary operational users are the bride, couple, and ceremony team represented by one or more `SITE_ADMIN` identities.
- The service operator is represented by `OWNER` and remains responsible for creation, visual customization, publishing, maintenance, and global administration.
- Guests are public visitors. A family or group representative may access protected guest actions after group-PIN verification, or optional future SMS verification; other group members do not need accounts.

### Managed service boundaries

EntreLaços owns the application behavior, public site composition, central panel, API rules, tenant isolation, and the operational data necessary for the agreed features. The operator owns site creation, visual implementation, content and media changes, review, deployment, domain and DNS actions, and support.

Sales, payment collection, contracts, content collection, guest-list collection, domain purchase, DNS changes, provider account administration, and other offline activities remain operator or external business processes. The application may record owner-entered status for these activities, but it does not claim to monitor external providers automatically.

### Commercial packages

The base managed site includes a customized wedding site, an infrastructure-provided public address, guest and group management, RSVP, messages, and the central operational panel. It does not include a custom domain or integrated gift list.

Custom domain service includes the base service plus domain purchase and DNS configuration as an additional manual service. Pricing, renewal ownership, and policy for a domain already owned by a client remain commercial decisions to be closed before launch.

An eventual complete package could add a custom domain and a gift-list capability. This package, gift lists, checkout, payment handling, and financial integrations are outside this MVP.

## Actors and Permissions

### `OWNER`

The `OWNER` is the global operator account. It can read, create, and manage all weddings, users, site lifecycle status, domains and origins, operational data, review approval, terms, usage controls, and support corrections. Only the owner can read across-wedding or global operational data. There is no public owner signup. Owner bootstrap and recovery use a restricted internal command or equivalent controlled procedure.

### `SITE_ADMIN`

The `SITE_ADMIN` is assigned to one wedding. The first access is created by the operator through a one-use, time-limited activation link. A bride, couple, or ceremony team may use the account according to the service arrangement; a separate ceremony account is optional and has the same site permissions. Identity sharing may be used initially, but it is not a reason to weaken tenant isolation.

`SITE_ADMIN` can manage groups, members, representatives, phone numbers, RSVP records, message moderation, RSVP deadline, and the mural toggle. It can read site status and term. It cannot manage themes, public content, users, domains, origins, service term, or global controls. An inactive wedding remains available for read-only consultation and export to its operational admins.

### Guest representative

The representative is the one contact for a group or individual invitation. The representative uses full name and registered phone to create a short-lived verification challenge, enters the group PIN shared by the bride or planner, answers members' RSVP, and publishes or edits the group's one message while the mural is enabled. The representative cannot add or remove members, change group composition, edit another group, or access any other wedding.

### Guest group member

A group member is a person recorded under a family/group invitation. The person has an individual RSVP state but no separate account in the MVP. The representative submits responses for the group; the system preserves each member's state.

### Public visitor

A public visitor can read enabled public pages and practical details without an account. The visitor cannot see private guest data, access the panel, submit RSVP, or publish a message without the appropriate guest verification.

## User Stories

### Service creation and public experience

1. **US-001 — As an operator, I want to create a wedding site record, so that one wedding has a stable identity throughout its service term.**
2. **US-002 — As an operator, I want each wedding to have a stable repository slug and public identity, so that a site can be rebuilt or redeployed without changing its tenant identity.**
3. **US-003 — As an operator, I want to compose custom pages and sections from a reusable template foundation, so that each wedding can look personal while common behavior stays consistent.**
4. **US-004 — As a couple, I want a public wedding site with my names, date, place, and approved visual identity, so that guests receive a personal invitation destination.**
5. **US-005 — As a public visitor, I want to open the wedding site without signing in, so that I can learn the story and practical information immediately.**
6. **US-006 — As a public visitor, I want the site to work on mobile and desktop, so that I can use the invitation on the device I have.**
7. **US-007 — As a public visitor, I want readable content and meaningful document order before motion loads, so that the story remains understandable under slow or limited JavaScript conditions.**
8. **US-008 — As a public visitor, I want a cinematic hero with an approved image or short muted video and a poster, so that the opening feels memorable without blocking access or requiring sound.**
9. **US-009 — As a public visitor, I want the hero to show the couple's names, date, and location with restrained entrance motion, so that the invitation communicates its essential identity immediately.**
10. **US-010 — As a public visitor, I want navigation to adapt from transparent over media to a readable solid treatment, so that I can navigate across changing backgrounds.**
11. **US-011 — As a public visitor, I want the couple's story presented through alternating editorial sections and one focused sticky storytelling sequence, so that the site has rhythm without turning every section into an interaction.**
12. **US-012 — As a public visitor, I want a compact gallery with usable controls, so that I can browse approved photos without losing the page context.**
13. **US-013 — As a public visitor, I want schedule, ceremony, reception, guidance, and directions presented directly, so that practical planning does not depend on cinematic effects.**
14. **US-014 — As a public visitor, I want responsive map embeds or direction links plus a copy-address fallback, so that I can find the venue even when an embed is unavailable.**
15. **US-015 — As a public visitor, I want the site footer to show names, date, available-section links, RSVP access, copyright/year, and the “By EntreLaços” text, so that the site has a consistent close and clear navigation.**
16. **US-016 — As a public visitor, I want reduced-motion mode to preserve all content and practical actions without forced scroll or choreography, so that accessibility settings do not remove information.**
17. **US-017 — As a public visitor, I want focus states, error feedback, and buttons to respond immediately, so that motion never hides whether an action succeeded.**
18. **US-018 — As an operator, I want to publish each wedding independently, so that an edit for one client cannot silently change another published site.**
19. **US-019 — As an operator, I want to review a site before launch, so that the first public release reflects approved content, media, and behavior.**

### Administrative access and site operations

20. **US-020 — As an operator, I want one central panel login, so that I can manage multiple weddings from one operational surface.**
21. **US-021 — As an `OWNER`, I want to choose among all authorized weddings after login, so that global administration and per-site work remain separate.**
22. **US-022 — As a `SITE_ADMIN`, I want to enter directly into my assigned wedding, so that I do not need to select or even see another tenant.**
23. **US-023 — As an `OWNER`, I want to create a first `SITE_ADMIN` activation, so that a client can obtain access without public signup.**
24. **US-024 — As a `SITE_ADMIN`, I want a one-use activation link valid for 24 hours, so that I can set a password through a controlled onboarding flow.**
25. **US-025 — As a `SITE_ADMIN`, I want the login email prefilled from the activation flow without being logged in automatically, so that I can complete an explicit login.**
26. **US-026 — As an `OWNER`, I want to revoke an unused or active activation, so that access can be controlled when a link is shared or becomes unsafe.**
27. **US-027 — As a controlled operator, I want recovery to use the same manually delivered, one-use pattern, so that account recovery does not depend on automatic email delivery.**
28. **US-028 — As an `OWNER`, I want a restricted bootstrap and recovery procedure, so that the global account cannot be created or recovered through a public route.**
29. **US-029 — As an authenticated admin, I want a visible logout action in the panel account menu, so that I can end my panel session deliberately.**
30. **US-030 — As an authenticated admin, I want idle sessions to expire after 24 hours and absolute sessions after 7 days, so that long-lived unattended access is limited.**
31. **US-031 — As an `OWNER`, I want the site’s activation status, public URL, dates, origins, and domains recorded, so that operational decisions have a visible system record.**
32. **US-032 — As an `OWNER`, I want to mark a review approved and start a one-year term, so that service duration has an explicit operational start.**
33. **US-033 — As an `OWNER`, I want to reactivate or deactivate a site manually, so that the recorded lifecycle follows the actual service decision.**
34. **US-034 — As a `SITE_ADMIN`, I want an inactive site to remain available for read-only consultation and export, so that I can recover operational information after public deactivation.**
35. **US-035 — As a public visitor, I want an inactive site to show a neutral placeholder, so that an expired site does not appear to be active or abandoned.**
36. **US-036 — As an `OWNER`, I want the application to preserve inactive-site data, so that expiration does not silently destroy records.**
37. **US-037 — As an `OWNER`, I want site and domain renewal to be separate records, so that a domain's registration responsibility does not change the wedding site's lifecycle.**
38. **US-038 — As an authorized admin, I want “Open site” to resolve the current wedding, so that panel navigation does not point to stale or unrelated URLs.**
39. **US-039 — As an authorized admin, I want a “Panel” entry on desktop and mobile public navigation, so that I can return to operations without exposing admin controls to guests.**
40. **US-040 — As an operator, I want guest sessions and administrative sessions to be independent, so that logging out of the panel does not grant or revoke guest access accidentally.**

### Guest groups and identity verification

41. **US-041 — As a `SITE_ADMIN`, I want to create a named family/group, so that related invitees can share one RSVP contact.**
42. **US-042 — As a `SITE_ADMIN`, I want a group name to be required, so that every invitation has a clear operational label.**
43. **US-043 — As a `SITE_ADMIN`, I want to add one or more named members to a group, so that attendance is tracked per person.**
44. **US-044 — As a `SITE_ADMIN`, I want to designate exactly one representative from the group, so that response authority is unambiguous.**
45. **US-045 — As a `SITE_ADMIN`, I want each group to have one normalized Brazilian phone number, so that verification and contact responsibility are deterministic.**
46. **US-046 — As a `SITE_ADMIN`, I want to create an individual invitation as a single-member group with that person as representative, so that solo guests use the same safe model.**
47. **US-047 — As a `SITE_ADMIN`, I want one phone per group per wedding to be unique, so that a verification request identifies one family within that wedding.**
48. **US-048 — As a `SITE_ADMIN`, I want the same phone to be usable in another wedding, so that uniqueness does not incorrectly cross tenant boundaries.**
49. **US-049 — As a `SITE_ADMIN`, I want to mark a foreign-number group, so that an administrative RSVP can be recorded when Brazilian SMS is unavailable.**
50. **US-050 — As a foreign-number invitee, I want a persistent explanation that SMS verification is unavailable for my case, so that I know why guest self-service is not offered.**
51. **US-051 — As a guest, I want to locate my group with full name and registered phone, so that I can request access without a secret link.**
52. **US-052 — As a guest, I want matching to ignore case, accents, and extra spaces, so that ordinary spelling differences do not prevent access.**
53. **US-053 — As an operator, I want matching to reject approximate, abbreviated, or incomplete names, so that name lookup cannot authorize the wrong group.**
54. **US-054 — As a representative, I want to enter the six-digit group PIN shared with my invitation, so that I can verify access without requiring a paid messaging provider.**
55. **US-055 — As a verified representative, I want a family-scoped guest session, so that I can act only for my wedding and group.**
56. **US-056 — As a guest using the optional SMS channel, I want a 60-second resend wait, so that accidental repeated requests do not overwhelm the provider. Manual PIN challenges have no resend.**
57. **US-057 — As an operator, I want send and failed-code limits by wedding/group and phone, with additional IP throttling, so that abuse is constrained without changing RSVP data.**
58. **US-058 — As a guest, I want five incorrect code attempts to interrupt the challenge and apply a 15-minute cooldown, so that an attacker cannot keep guessing indefinitely.**
59. **US-059 — As a guest, I want resend actions not to reset abuse counters, so that rate limits reflect actual activity.**
60. **US-060 — As an authenticated guest, I want a seven-day absolute session lifetime, so that a device does not keep indefinite access.**
61. **US-061 — As an authenticated guest, I want a clear way to leave the RSVP flow, so that I can end the family session from the guest interface.**
62. **US-062 — As an operator, I want a representative/phone change or PIN rotation to revoke family sessions and pending challenges, so that old identity proof cannot survive an access change.**
63. **US-063 — As an operator, I want spelling correction to preserve existing guest data and sessions, so that a harmless name fix does not disrupt the family.**
64. **US-064 — As a system operator, I want every guest request authorized by the API, so that a browser cannot choose a different wedding or group by changing a site identifier.**
65. **US-065 — As an operator, I want a demo verification path to require owner authorization and a demo-marked site, so that simulations never become a general guest bypass.**

### RSVP

66. **US-066 — As a guest representative, I want to see every member in my group, so that I can answer for the complete invitation.**
67. **US-067 — As a guest representative, I want each member to have `PENDING`, `CONFIRMED`, or `DECLINED`, so that partial attendance is represented accurately.**
68. **US-068 — As a guest representative, I want a confirm-all shortcut that remains a draft until I save, so that I can fill common responses quickly without accidental submission.**
69. **US-069 — As a guest representative, I want to save all selected member responses explicitly, so that no response changes merely because I viewed the form.**
70. **US-070 — As a guest representative, I want some members to remain pending while others are confirmed or declined, so that the group can respond incrementally.**
71. **US-071 — As a guest representative, I want the same RSVP form to work as a mobile full-screen experience and a desktop modal, so that the action remains focused on every device.**
72. **US-072 — As an operator, I want an RSVP deadline with an explicit timezone, so that the lock moment is unambiguous to guests and admins.**
73. **US-073 — As a guest, I want to read my RSVP after the deadline but be prevented from changing it, so that the recorded deadline is enforceable.**
74. **US-074 — As a `SITE_ADMIN`, I want to record or correct RSVP after the deadline, so that externally received answers can still be maintained.**
75. **US-075 — As a `SITE_ADMIN`, I want to update one member or all members through an explicit operational action, so that corrections do not require guest self-service.**
76. **US-076 — As a system operator, I want pending responses never to be auto-declined, so that lack of action does not become an invented attendance decision.**
77. **US-077 — As a system operator, I want member-level optimistic concurrency, so that a stale submission cannot overwrite a newer response.**
78. **US-078 — As a guest representative, I want a conflict to preserve my current selections and explain that data changed, so that I can review before retrying.**
79. **US-079 — As an operator, I want unrelated members to remain independently editable during a conflict, so that one change does not block safe corrections elsewhere.**
80. **US-080 — As a `SITE_ADMIN`, I want RSVP filters and totals by status and group, so that I can organize follow-up work.**
81. **US-081 — As an operator, I want RSVP history separate from the current operational view, so that before/after values, actor, time, group, and member can be audited without cluttering daily work.**
82. **US-082 — As an operator, I want monthly message limits to leave saved RSVP and existing guest sessions usable, so that an SMS budget does not block core administration.**

### Messages and mural

83. **US-083 — As a verified representative, I want one text message per group, so that I can leave a concise greeting without creating a message feed per member.**
84. **US-084 — As a verified representative, I want to write up to 1,000 characters including emojis and newlines, so that the message supports natural celebration text.**
85. **US-085 — As a verified representative, I want the public message author to be my registered name and group, so that the mural does not rely on freely typed identity.**
86. **US-086 — As a verified representative, I want to edit my group message while the mural is enabled, so that I can correct or refine what I published.**
87. **US-087 — As a `SITE_ADMIN` or `OWNER`, I want to delete a message, so that inappropriate or unwanted content can be removed.**
88. **US-088 — As an administrator, I want deletion to allow the representative to publish again when permitted, so that moderation does not permanently silence a group.**
89. **US-089 — As an administrator, I want to block or unblock a group for message publication/editing, so that a moderation decision applies to the mural without blocking RSVP.**
90. **US-090 — As an administrator, I want to toggle the mural per wedding, so that a couple or ceremony team can disable public messages while retaining data.**
91. **US-091 — As a public visitor, I want messages to omit phone numbers, member lists, and RSVP states, so that the mural does not expose private invitation data.**
92. **US-092 — As a `SITE_ADMIN`, I want to delete a group only after explicit confirmation, so that destructive maintenance is deliberate.**
93. **US-093 — As an operator, I want group deletion to remove its members, RSVP, messages, sessions, and pending challenges, so that no orphaned access or guest record remains.**

### Exports, usage, and operational controls

94. **US-094 — As an authorized admin, I want a PDF export scoped to one wedding, so that I can print or archive an attendance report.**
95. **US-095 — As an authorized admin, I want a CSV export scoped to one wedding, so that I can use RSVP data in external operational workflows.**
96. **US-096 — As an authorized admin, I want exports to show heading, generated date/time, totals, groups, individual names, statuses, and representative phone according to selected inclusion/filter options, so that reports are useful without exposing messages.**
97. **US-097 — As an authorized admin, I want PDF output to paginate cleanly, so that a long guest list remains printable.**
98. **US-098 — As an `OWNER`, I want a numeric monthly SMS send ceiling per wedding, so that a provider budget is visible and enforceable.**
99. **US-099 — As an `OWNER`, I want usage alerts at 80% and 100%, so that I can investigate a rising spend before sends are blocked.**
100. **US-100 — As a host administrator, I want blocked new SMS sends to explain that the host must be contacted, so that the limit is understandable and does not look like a guest data failure.**
101. **US-101 — As an `OWNER`, I want a demo site's send behavior to be simulation-only unless I explicitly authorize an allowlisted browser and phone, so that demos cannot consume uncontrolled provider capacity.**
102. **US-102 — As an operator, I want test environments to use deterministic mocked SMS by default, so that tests do not require real provider delivery.**
103. **US-103 — As an operator, I want a real Twilio Verify path to be explicitly opt-in and permission-checked, so that the system makes no claim of live delivery without valid account, country, trial, and usage access.**

### Provisioning, deployment, and reliability

104. **US-104 — As an operator, I want one resumable provisioning command and a documented repository skill, so that a new wedding can be prepared consistently.**
105. **US-105 — As an operator, I want provisioning to be idempotent, so that retries do not duplicate sites, accounts, or data.**
106. **US-106 — As an operator, I want provisioning to avoid overwriting existing code, passwords, or unrelated data, so that recovery from an interrupted run is safe.**
107. **US-107 — As an operator, I want provisioning to create an API draft site and first account through an authenticated internal API operation, so that scripts do not bypass business rules by writing directly to the database.**
108. **US-108 — As an operator, I want development to be the default provisioning environment, so that a setup action cannot accidentally modify the main environment.**
109. **US-109 — As an operator, I want explicit reuse of an existing configuration to preserve operational data, so that development refreshes do not wipe guests, RSVP, sessions, or passwords.**
110. **US-110 — As an operator, I want a clean operational dataset for the first production deploy, so that real guest entry begins during review and is never reset at launch.**
111. **US-111 — As an operator, I want a site to deploy independently to its public address, so that one wedding can be reviewed and released without a mass publish.**
112. **US-112 — As an operator, I want manual production deployment, domain, and DNS actions represented as owner-entered status, so that the panel remains honest about external infrastructure.**
113. **US-113 — As an operator, I want explicit allowlisted browser origins/CORS per wedding, so that cross-origin browser access never relies on a wildcard.**
114. **US-114 — As an operator, I want burst, load, and tenant-isolation evidence for twenty active weddings and five hundred guests per wedding planning targets, so that capacity assumptions are tested rather than implied.**
115. **US-115 — As an operator, I want a documented recovery target of RPO at most one hour and RTO at most eight hours only after tier, retention, cost, and real restoration proof are confirmed, so that continuity claims remain evidence-based.**
116. **US-116 — As an operator, I want privacy, retention, data rights, and client media permissions validated before launch, so that the service does not present unresolved legal assumptions as compliance.**
117. **US-117 — As an operator, I want CI to run types, lint, tests, builds, and disposable database integration when explicit credentials exist, so that the delivery gate reflects real dependencies.**
118. **US-118 — As an operator, I want main-environment migrations and production deployment to require explicit manual action, so that automation cannot mutate production silently.**

### Administration, transparency, and support

119. **US-119 — As an `OWNER`, I want to read, correct, or remove operational data globally, so that support can resolve mistakes within the service rules.**
120. **US-120 — As a `SITE_ADMIN`, I want to see only my wedding's data and actions, so that client operations remain private and tenant isolation is understandable.**
121. **US-121 — As a public visitor, I want the site to identify the current practical actions clearly, so that RSVP, directions, schedule, and messages do not get buried by decorative sections.**
122. **US-122 — As a couple or ceremony team, I want a consistent operational explanation for foreign numbers, expired deadlines, blocked messages, inactive sites, and rate limits, so that guests know what to do next.**
123. **US-123 — As an operator, I want the system to distinguish a test simulation from a real provider result, so that support and clients never mistake a mock for delivery evidence.**
124. **US-124 — As a service owner, I want unresolved legal, recovery, media, and provider decisions to appear as technical launch gates while commercial policy is tracked separately, so that implementation cannot silently turn open questions into promises.**

## Product Requirements and Behavioural Rules

### Site lifecycle

Each wedding has one stable configuration identity containing template choice, content, media references, settings, and operational status. It contains no secrets. A provisioning operation prepares the local site and asks the API to create or resume the draft tenant and first administrative access. The operation is resumable and does not overwrite code, passwords, or existing operational data.

Development is the default environment. Reusing a configuration is an explicit action and preserves guest, RSVP, session, and password data. Production starts with clean operational data. The bride or ceremony team may begin entering real guests during review; launch must never wipe that data.

The operator performs the first public deployment before or during review. The public site is not preview-protected by default; the product communicates that the public address must not be shared before review. Domain and DNS work is manual. The panel records owner-entered status and does not claim provider monitoring.

The initial service term is one year from owner-approved review and launch. Dates may be edited by the operator. At or after the end of the term, the owner manually deactivates the public site, which then displays a neutral placeholder. Data is preserved. Reactivation and read-only export remain available according to the accepted operational rules. Renewal is an external business policy; retention and deletion require explicit product and legal decisions. Domain registration and renewal are separate from the site term; expiry does not trigger automatic enforcement.

### Administrative authentication and authorization

There is one central panel login with separate global owner management and per-site operational areas. The owner sees a wedding chooser or an authorized-origin wedding entry. A site administrator enters only the assigned wedding. Public pages may expose “Panel” only as a navigation entry for an administrator, never as guest authorization.

Activation uses a random, hashed, one-use token with a 24-hour validity window. The owner manually delivers the activation link. The recipient defines a password and then logs in explicitly with the email prefilled. Recovery follows a controlled, manually delivered pattern. There is no public signup and no automatic email requirement.

Administrative sessions expire after 24 hours of inactivity or seven days absolutely. Logout is available only from the panel account menu and invalidates the derivative site recognition. Cross-domain recognition between the public wedding site, panel, and API is a design spike requirement. The product does not claim that same-origin, BFF, cookie, or handoff behavior is solved until an authenticated browser test proves the selected design.

### Guest groups and identity

The group is the unit of organization and authorization. A group has a required name, at least one named member, one representative, and one normalized Brazilian phone. An individual invitation is modeled as a single-member group. The phone is unique within a wedding/group scope but may occur in another wedding.

Foreign-number groups make the phone optional and are administrative RSVP only. They do not receive guest SMS authentication, guest messages, or a substitute guest account. The interface keeps the explanation visible and provides a Sonner toast when the foreign-number path affects an action.

The guest lookup uses full name and registered phone. Matching ignores case, accents, and extra spaces but rejects approximate or abbreviated names. By default, the API validates the match and creates a 10-minute manual challenge without contacting a provider. The guest enters the group PIN that an authorized administrator copied and shared externally. The API creates a family-bound session after the correct PIN. The browser cannot select a tenant or group by changing an identifier.

Each Brazilian group receives a random server-side seed at creation. A domain-separated HMAC with the existing guest server secret derives the persistent six-digit PIN; plaintext PINs are not stored. Authorized administrators may transiently reveal or rotate it. Rotation invalidates the old PIN and revokes active family sessions and pending challenges. Sending the PIN through WhatsApp or another channel is a human operation outside the product integration.

Manual verification applies exact-lookup and IP attempt throttles, five incorrect PIN attempts before a 15-minute cooldown, and no resend. Optional SMS protection additionally includes a 60-second resend wait, maximum three total sends (including the initial send) per 15 minutes and ten total sends per 24 hours by wedding/group and phone, plus send IP throttles. Resend does not reset counters. Limits do not delete RSVP or interrupt existing valid sessions. Guest sessions expire absolutely after seven days. Representative/phone changes and PIN rotation revoke family sessions and pending challenges; spelling-only corrections do not.

### RSVP

RSVP is individual per member and has exactly three initial states: `PENDING`, `CONFIRMED`, and `DECLINED`. The representative responds for all members in the family. The interface supports a confirm-all draft shortcut and partial responses. The save is explicit.

The deadline is a configured datetime with an explicit timezone. Guests can read but cannot change RSVP after the deadline. Admins can record or correct responses after the deadline, including answers received through external channels. Pending responses remain pending until a person or administrator changes them.

Member-level concurrency protects against stale writes. A conflicting all-or-nothing submission retains the user's selections, explains that data changed, and permits retry after review. Unrelated members can be changed independently.

### Messages and mural

Each group has at most one text message of 1,000 characters, with emojis and newlines accepted and HTML/attachments excluded. Only a verified representative can author or edit it while the mural is enabled. The public author label comes from the verified registered name and group. The public message never reveals phone, member list, or RSVP.

Admins can delete messages but never edit their text. Deletion does not prevent later publication. Admins can block a group from message publication/editing without affecting RSVP. The mural toggle is per wedding, controlled by bride/ceremony admins or owner, hides and blocks writes while retaining existing data.

Group deletion requires explicit confirmation and cascades its members, RSVP, messages, sessions, and pending challenges. Final retention behavior after deletion or expiration is a launch gate rather than an implicit promise.

### Exports and usage limits

Authorized admins can export a wedding-scoped PDF and CSV report. Reports include heading, generated date/time, totals, groups, member names and RSVP status, and representative phone according to an inclusion/filter choice. Reports exclude messages. PDF output is paginated and printable. Inactive sites retain read-only export access.

The owner configures a per-wedding monthly SMS send ceiling. The default ceiling is a numeric decision still to be set. The dashboard shows usage and alerts at 80% and 100%. When the ceiling blocks new sends, active sessions, saved RSVP, and administrative RSVP remain available, and the UI directs the host to the operator. Demo simulation and real delivery are labelled separately.

### Visual and media experience

The first template follows a provisional ivory, dark olive, serif-led cinematic editorial direction. The reference family supports an image-led hero, transparent-to-solid navigation, alternating sections, one desktop sticky story sequence, compact gallery, and direct practical sections. The visual direction and logo are not final approval. Template and public-site language is always Brazilian Portuguese (`pt-BR`); sites and templates are never authored in `en-US`.

The hero accepts an approved image or short muted loop video with poster. Any image-to-video transition, fictional-couple image set, and video provider selection require a later media gate covering client approval, consistency, cost, rights, credentials, and performance. Image generation may be available for approved fictional demo material; no media generation is part of this documentation task.

Motion uses short transitions and staggered text only where it supports comprehension. One expressive character-text statement is permitted. Practical UI feedback is immediate. Reduced motion removes parallax, forced scrolling, smooth-scroll choreography, and large transforms while keeping all content.

The public information architecture is initially one landing experience but allows additional public pages later. The demo may use one ceremony/reception venue with illustrative location data; it must not use invented venue photos as authentic documentation.

## Implementation Decisions

These are product-facing boundaries accepted for subsequent architecture work. They do not authorize implementation by themselves.

- Public wedding sites are static Astro applications, independently deployed per wedding on Cloudflare Workers Static Assets.
- The central panel is a TanStack Start application on Cloudflare Workers.
- A Hono Node.js/TypeScript API on Railway is the sole business-rule, authorization, tenant-isolation, and database authority.
- PostgreSQL on Neon is shared and multi-tenant, with every business query isolated by wedding/site identity. Development and main environments are distinct; disposable Neon bases are used for integration tests.
- The monorepo uses Bun workspaces and Turborepo. The agreed application/package boundaries are public admin, API, demo wedding site, template foundation, shared wedding guest behavior, UI primitives, contracts, and database concerns. Exact implementation structure belongs in the later architecture specification.
- Drizzle, node-postgres, and manually reviewed SQL migrations are the selected data-access direction. Main-environment migrations are explicit manual operations.
- Better Auth with database persistence is the selected administrative authentication direction. Guest sessions remain independently scoped.
- `/v1` HTTP JSON API contracts use standardized error shapes and shared contract definitions separate from database models.
- The UI uses shadcn with Base UI and Sonner. Motion is selected for the approved intro, text, and story choreography; CSS/Intersection Observer remain appropriate for simple interactions and entrances.
- Composition over inheritance governs template design: reusable sections and layout provide defaults; each site composes its pages and custom content. Template defaults and every public wedding site are written in Brazilian Portuguese (`pt-BR`) only; `en-US` is not a template or site locale.
- Shared changes apply only to newly built sites. Every wedding receives independent review and deployment; no silent mass publish exists.
- The first production infrastructure is manual. Cloudflare account/app setup, Railway deployment configuration, Neon environments, Twilio setup, domains, DNS, and provider permissions are recorded and verified separately.
- Allowed browser origins/CORS are explicit per wedding. Wildcard CORS or authorization is not permitted.
- No public frontend connects directly to Neon.

## Quality, Security, and Operational Requirements

- Target planning capacity is 20 active weddings with 500 guests per wedding. This is a test target, not a proven hard capacity.
- Burst, load, and cross-tenant isolation tests are required before production claims.
- The recovery target is RPO at most one hour and RTO at most eight hours only if Neon tier, retention, cost, and a real restoration exercise prove it. Until then, the target is unresolved.
- Privacy, retention, rights requests, client media permissions, and legal policy must receive external validation before launch. The product must not claim LGPD compliance from technical behavior alone.
- Configuration examples may contain public values, but secrets must remain in the intended secret stores. Frontend bundles must never receive Neon, Railway, Better Auth, Twilio, or other server credentials.
- Automated CI covers types, lint, unit/contract tests, builds, and disposable-database integration when explicit test credentials and resources are available. CI must not mutate main data or deploy production automatically.
- TDD applies to logic-bearing behavior. Tests use deterministic fixtures and mocked external providers by default. A mocked Twilio or media provider is test infrastructure, not evidence of a live provider guarantee.
- Production data mutations, migrations, deployments, domain operations, and deactivation remain explicitly authorized manual actions.
- Public and guest flows must be tested in clean browsers, including cross-origin behavior, session invalidation, deadline locking, reduced motion, mobile layout, and inactive-site behavior.

## Success Metrics and Product Acceptance

The initial success measure is an operator completing a wedding's path from approved configuration to public review with no duplicate tenant, no lost operational data, and a clear manual status record. A production-ready milestone should demonstrate:

- a fresh wedding can be prepared idempotently and independently;
- an owner can create and recover a controlled administrative access and keep the site admin within one wedding;
- a representative can complete provider-free manual PIN verification; an optional real SMS path either passes every permission/provider gate or returns an honest blocked state;
- a group can save full, partial, and changed RSVP while deadline and concurrency rules hold;
- message publishing, editing, deletion, moderation, mural disablement, and privacy boundaries hold;
- PDF and CSV exports remain wedding-scoped, paginated where applicable, and free of messages;
- public pages work responsively with practical information immediately usable and reduced motion preserving content;
- demo simulation is visibly marked, owner-authorized, and isolated from sentinel real data;
- tests show cross-tenant isolation, abuse limits, burst/load behavior, and clean-browser session behavior;
- recovery, legal/retention, media rights, provider access, and production infrastructure gates are either evidenced or explicitly marked blocked before launch.

## Out of Scope

- Self-service customer signup, CMS editing, or customer-managed visual design.
- Customer or guest uploads, object storage, shared media libraries, or runtime media editing.
- Gifts, gift lists, checkout, Pix handling inside the product, payment processing, split payments, financial webhooks, KYC, conciliation, refunds, chargebacks, or a mandated external gift provider.
- WhatsApp API integration or authentication, automated WhatsApp fallback, international SMS, and non-Twilio SMS providers in the MVP. Administrators may manually paste the copied group PIN into their own communication channel.
- Individual guest accounts, guest-created accounts, secret invitation links, guest addition/removal of members, or guest changes to group composition.
- Automatic email delivery for activation or recovery.
- Automatic provider monitoring, automatic domain/DNS changes, automatic expiry deletion, automatic renewal, automatic main migrations, and automatic production deployment.
- Multiple invitation variants, sub-event invitations, or RSVP flows split by ceremony and reception.
- Public message approval queues, administrator message editing, attachments, or arbitrary HTML.
- Guaranteed capacity, guaranteed RPO/RTO, legal compliance, media licensing, or provider delivery without evidence and a completed gate.
- Final brand mark, final typography/palette approval, speculative finished visuals, and media generation in this documentation phase.
- A separate permanent demo environment or database.

## Open Decisions and Launch Gates

The following items are intentionally unresolved and must be closed or explicitly accepted as a launch limitation:

1. Commercial buyer, pricing, revision policy, cancellation, renewal, tolerance period, and support service levels. These are external business-policy decisions, not technical MVP blockers, but must be addressed for commercial operations.
2. Numeric default and enforcement policy for the monthly SMS ceiling.
3. Neon tier, retention settings, cost, backup strategy, and real restoration proof for RPO/RTO targets.
4. Privacy notice, retention schedule, data rights handling, deletion exceptions, client media permissions, and legal review.
5. Authenticated cross-origin design between public wedding sites, panel, and API, including same-origin/BFF/cookie or time-bound handoff choice and clean-browser proof.
6. Cloudflare, Railway, Neon, CI, and Twilio accounts, credentials, project access, regional/country permissions, trial constraints, and usage limits.
7. Media provider, image/video rights, costs, API keys, performance budget, fictional-couple approval, and image-to-video poster workflow.
8. Final visual direction, brand/logo/favicons, and acceptance of the provisional palette and motion vocabulary.
9. Operational scale beyond the target and the response to Cloudflare's Worker-per-wedding account limits.
10. Production domain and DNS responsibilities, including custom-domain ownership and renewal policy.

## Further Notes

This PRD records the accepted product interview and is pending the user's PRD review. The architecture specification is a separate artifact. The implementation plan paired with it is deliberately marked **DRAFT** because the eight proposed blocks require a user granularity review before work is scheduled.

This PRD and its draft plan do not themselves provision providers, create secrets, generate media, deploy a site, or promise a live integration.
