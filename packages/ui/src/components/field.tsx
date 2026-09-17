import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../lib/utils";

const fieldVariants = cva("group/field flex w-full", {
  variants: {
    orientation: {
      vertical: "flex-col gap-2",
      horizontal: "flex-row items-center gap-3",
      responsive:
        "flex-col gap-2 @md/field-group:flex-row @md/field-group:items-center @md/field-group:gap-3",
    },
  },
  defaultVariants: { orientation: "vertical" },
});

function FieldSet({
  className,
  ...props
}: React.ComponentProps<"fieldset">): React.JSX.Element {
  return (
    <fieldset
      data-slot="field-set"
      className={cn("flex flex-col gap-6", className)}
      {...props}
    />
  );
}

function FieldLegend({
  className,
  variant = "legend",
  ...props
}: React.ComponentProps<"legend"> & {
  variant?: "legend" | "label";
}): React.JSX.Element {
  return (
    <legend
      data-slot="field-legend"
      data-variant={variant}
      className={cn(
        variant === "label"
          ? "text-sm leading-none font-medium"
          : "text-base font-semibold",
        className,
      )}
      {...props}
    />
  );
}

function FieldGroup({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="field-group"
      className={cn(
        "@container/field-group flex w-full flex-col gap-6",
        className,
      )}
      {...props}
    />
  );
}

function Field({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof fieldVariants>): React.JSX.Element {
  return (
    // biome-ignore lint/a11y/useSemanticElements: Field supports arbitrary controls and orientations.
    <div
      role="group"
      data-slot="field"
      data-orientation={orientation}
      className={cn(fieldVariants({ orientation }), className)}
      {...props}
    />
  );
}

function FieldContent({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="field-content"
      className={cn("flex min-w-0 flex-1 flex-col gap-1.5", className)}
      {...props}
    />
  );
}

function FieldLabel({
  className,
  ...props
}: React.ComponentProps<"label">): React.JSX.Element {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: Callers associate native labels with htmlFor or nested controls.
    <label
      data-slot="field-label"
      className={cn("text-sm leading-none font-medium", className)}
      {...props}
    />
  );
}

function FieldTitle({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="field-title"
      className={cn(
        "flex items-center text-sm leading-none font-medium",
        className,
      )}
      {...props}
    />
  );
}

function FieldDescription({
  className,
  ...props
}: React.ComponentProps<"p">): React.JSX.Element {
  return (
    <p
      data-slot="field-description"
      className={cn("text-sm leading-normal text-muted-foreground", className)}
      {...props}
    />
  );
}

function FieldSeparator({
  children,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      data-slot="field-separator"
      className={cn("relative h-px w-full bg-border", className)}
      {...props}
    >
      {children && (
        <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-background px-2 text-xs text-muted-foreground">
          {children}
        </span>
      )}
    </div>
  );
}

function FieldError({
  className,
  children,
  errors,
  ...props
}: React.ComponentProps<"div"> & {
  errors?: Array<{ message?: string } | undefined>;
}): React.JSX.Element | null {
  const content =
    children ??
    (() => {
      const messages = [
        ...new Set(
          errors?.map((error) => error?.message).filter(Boolean) as string[],
        ),
      ];
      if (messages.length === 0) return null;
      if (messages.length === 1) return messages[0];
      return (
        <ul className="ml-4 list-disc space-y-1">
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      );
    })();

  if (!content) return null;

  return (
    <div
      role="alert"
      data-slot="field-error"
      className={cn("text-sm font-normal text-destructive", className)}
      {...props}
    >
      {content}
    </div>
  );
}

export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
};
