import type * as React from "react";
import { cn } from "../lib/utils";

function Card({
  className,
  size = "default",
  ...props
}: React.ComponentPropsWithRef<"div"> & {
  size?: "default" | "sm";
}): React.JSX.Element {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        "flex flex-col rounded-xl border border-border bg-card text-card-foreground shadow-sm",
        size === "sm" ? "gap-3 p-4" : "gap-6 p-6",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({
  className,
  ...props
}: React.ComponentPropsWithRef<"div">): React.JSX.Element {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "grid auto-rows-min items-start gap-1.5 has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-action]:gap-x-4",
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({
  className,
  ...props
}: React.ComponentPropsWithRef<"h3">): React.JSX.Element {
  return (
    <h3
      data-slot="card-title"
      className={cn(
        "text-lg leading-none font-semibold tracking-tight",
        className,
      )}
      {...props}
    />
  );
}

function CardDescription({
  className,
  ...props
}: React.ComponentPropsWithRef<"p">): React.JSX.Element {
  return (
    <p
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

function CardAction({
  className,
  ...props
}: React.ComponentPropsWithRef<"div">): React.JSX.Element {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className,
      )}
      {...props}
    />
  );
}

function CardContent({
  className,
  ...props
}: React.ComponentPropsWithRef<"div">): React.JSX.Element {
  return (
    <div
      data-slot="card-content"
      className={cn("pt-0", className)}
      {...props}
    />
  );
}

function CardFooter({
  className,
  ...props
}: React.ComponentPropsWithRef<"div">): React.JSX.Element {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center pt-0", className)}
      {...props}
    />
  );
}

export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
};
