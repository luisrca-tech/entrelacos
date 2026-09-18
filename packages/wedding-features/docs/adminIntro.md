# Administrator intro

Recognized administrators see a `Painel` header link and, once per browser per
site, a non-modal footer banner that explains administrator mode.

The banner is product onboarding, not a legal consent. Repeating it on every
panel handoff would interrupt the owner who previews the public site
continuously. It is portaled to `document.body` so `position: fixed` can sit on
the viewport bottom; the header animation would otherwise trap it at the top.
`localStorage`. Confirming (the Entendi button or Escape) writes that key and
closes the banner. The `Painel` link remains for as long as server-backed
recognition is valid.

The banner returns only on a different browser or device, or after site data is
cleared. Public visitors never receive the link or the banner. Blocked storage
must not break recognition: a failed read is treated as not dismissed, and a
failed write is ignored while the in-memory dismiss still hides the banner for
the rest of the tab.
