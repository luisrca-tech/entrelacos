# `@entrelacos/ui`

Shared React primitives for the central admin surface and future functional islands. It currently exports `Button`, `buttonVariants`, `Toaster`, `cn`, and a small stylesheet.

`Button` follows the shadcn Base UI `base-nova` source shape and uses `@base-ui/react/button`. `Toaster` wraps Sonner. This package intentionally contains no domain behavior or authentication state.

`components.json` keeps the base-nova registry settings and package aliases available to future shadcn additions. Consuming apps should import their Tailwind entrypoint after `tailwindcss` and include `packages/ui/src` in the source scan.
