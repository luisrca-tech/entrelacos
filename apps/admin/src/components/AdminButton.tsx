import { Button, cn } from "@entrelacos/ui";
import type { ComponentProps } from "react";

type SharedButtonProps = ComponentProps<typeof Button>;
type SharedButtonVariant = NonNullable<SharedButtonProps["variant"]>;

export type AdminButtonTone =
  | "primary"
  | "secondary"
  | "danger"
  | "ghost"
  | "link";

// The shared Button stays untouched for the public sites; each admin tone
// replaces every color class of its base variant (tailwind-merge drops the
// shared ones), so the admin never resolves to the dark `bg-foreground` pill.
const focus =
  "focus-visible:border-admin-accent focus-visible:ring-admin-accent/30";

const tones: Record<
  AdminButtonTone,
  { variant: SharedButtonVariant; className: string }
> = {
  primary: {
    variant: "default",
    className:
      "bg-admin-accent text-admin-on-accent hover:bg-admin-accent-hover",
  },
  secondary: {
    variant: "outline",
    className:
      "border-admin-border bg-admin-surface text-admin-text hover:bg-admin-subtle hover:text-admin-text aria-expanded:bg-admin-subtle aria-expanded:text-admin-text dark:border-admin-border dark:bg-admin-surface dark:hover:bg-admin-subtle",
  },
  danger: {
    variant: "default",
    className:
      "bg-admin-danger text-admin-on-accent hover:bg-admin-danger-text",
  },
  ghost: {
    variant: "ghost",
    className:
      "text-admin-accent-hover hover:bg-admin-accent-subtle hover:text-admin-accent-hover aria-expanded:bg-admin-accent-subtle aria-expanded:text-admin-accent-hover dark:hover:bg-admin-accent-subtle",
  },
  link: {
    variant: "link",
    className: "text-admin-accent-hover",
  },
};

export type AdminButtonProps = Omit<SharedButtonProps, "variant"> & {
  tone: AdminButtonTone;
};

export function AdminButton({ tone, className, ...props }: AdminButtonProps) {
  const { variant, className: toneClassName } = tones[tone];
  const base = `${toneClassName} ${focus}`;

  return (
    <Button
      data-tone={tone}
      variant={variant}
      className={
        typeof className === "function"
          ? (state) => cn(base, className(state))
          : cn(base, className)
      }
      {...props}
    />
  );
}
