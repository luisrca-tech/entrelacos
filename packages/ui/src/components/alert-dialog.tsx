import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import type { Button as ButtonPrimitive } from "@base-ui/react/button";
import type * as React from "react";
import { cn, cnState } from "../lib/utils";
import { Button } from "./button";

function AlertDialog(
  props: AlertDialogPrimitive.Root.Props,
): React.JSX.Element {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger(
  props: AlertDialogPrimitive.Trigger.Props,
): React.JSX.Element {
  return (
    <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
  );
}

function AlertDialogPortal(
  props: AlertDialogPrimitive.Portal.Props,
): React.JSX.Element {
  return (
    <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
  );
}

function AlertDialogOverlay(
  props: AlertDialogPrimitive.Backdrop.Props,
): React.JSX.Element {
  const { className, ...rest } = props;
  return (
    <AlertDialogPrimitive.Backdrop
      data-slot="alert-dialog-overlay"
      className={cnState<AlertDialogPrimitive.Backdrop.State>(
        "fixed inset-0 z-50 bg-foreground/45 transition-opacity motion-reduce:transition-none data-[starting-style]:opacity-0",
        className,
      )}
      {...rest}
    />
  );
}

function AlertDialogContent({
  className,
  size = "default",
  ...props
}: AlertDialogPrimitive.Popup.Props & {
  size?: "default" | "sm";
}): React.JSX.Element {
  const sizeClassName = size === "sm" ? "max-w-sm" : "max-w-lg";
  const popupClassName =
    typeof className === "function"
      ? (state: AlertDialogPrimitive.Popup.State) =>
          cn(sizeClassName, className(state))
      : cn(sizeClassName, className);

  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-content"
        data-size={size}
        className={cnState<AlertDialogPrimitive.Popup.State>(
          "fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border border-border bg-card p-6 text-card-foreground shadow-xl outline-none transition-opacity motion-reduce:transition-none data-[starting-style]:opacity-0",
          popupClassName,
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({
  className,
  ...props
}: React.ComponentPropsWithRef<"div">): React.JSX.Element {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

function AlertDialogFooter({
  className,
  ...props
}: React.ComponentPropsWithRef<"div">): React.JSX.Element {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogMedia({
  className,
  ...props
}: React.ComponentPropsWithRef<"div">): React.JSX.Element {
  return (
    <div
      data-slot="alert-dialog-media"
      className={cn(
        "mb-1 flex size-10 items-center justify-center rounded-lg",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogTitle({
  className,
  ...props
}: AlertDialogPrimitive.Title.Props): React.JSX.Element {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cnState<AlertDialogPrimitive.Title.State>(
        "text-lg leading-none font-semibold tracking-tight",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: AlertDialogPrimitive.Description.Props): React.JSX.Element {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cnState<AlertDialogPrimitive.Description.State>(
        "text-sm text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogAction({
  className,
  ...props
}: React.ComponentProps<typeof Button>): React.JSX.Element {
  return (
    <Button
      data-slot="alert-dialog-action"
      className={cnState<ButtonPrimitive.State>("sm:min-w-24", className)}
      {...props}
    />
  );
}

function AlertDialogCancel({
  className,
  variant = "outline",
  size = "default",
  ...props
}: AlertDialogPrimitive.Close.Props &
  Pick<
    React.ComponentProps<typeof Button>,
    "variant" | "size"
  >): React.JSX.Element {
  return (
    <AlertDialogPrimitive.Close
      data-slot="alert-dialog-cancel"
      className={cnState<AlertDialogPrimitive.Close.State>(
        "sm:min-w-24",
        className,
      )}
      render={<Button variant={variant} size={size} />}
      {...props}
    />
  );
}

function AlertDialogClose(
  props: AlertDialogPrimitive.Close.Props,
): React.JSX.Element {
  return (
    <AlertDialogPrimitive.Close data-slot="alert-dialog-close" {...props} />
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
