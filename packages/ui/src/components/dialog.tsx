import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type * as React from "react";
import { cn, cnState } from "../lib/utils";
import { Button } from "./button";

function Dialog(props: DialogPrimitive.Root.Props): React.JSX.Element {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger(
  props: DialogPrimitive.Trigger.Props,
): React.JSX.Element {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal(props: DialogPrimitive.Portal.Props): React.JSX.Element {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose(props: DialogPrimitive.Close.Props): React.JSX.Element {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay(
  props: DialogPrimitive.Backdrop.Props,
): React.JSX.Element {
  const { className, ...rest } = props;
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cnState<DialogPrimitive.Backdrop.State>(
        "fixed inset-0 z-50 bg-foreground/45 transition-opacity motion-reduce:transition-none data-[starting-style]:opacity-0",
        className,
      )}
      {...rest}
    />
  );
}

type DialogContentProps = DialogPrimitive.Popup.Props & {
  overlayClassName?: DialogPrimitive.Backdrop.Props["className"];
  showCloseButton?: boolean;
};

function DialogContent({
  className,
  children,
  overlayClassName,
  showCloseButton = false,
  ...props
}: DialogContentProps): React.JSX.Element {
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cnState<DialogPrimitive.Popup.State>(
          "fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-lg min-w-0 -translate-x-1/2 -translate-y-1/2 gap-4 overflow-x-hidden rounded-xl border border-border bg-card p-6 text-card-foreground shadow-xl outline-none transition-opacity motion-reduce:transition-none data-[starting-style]:opacity-0",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="absolute top-3 right-3"
              />
            }
          >
            <X aria-hidden="true" />
            <span className="sr-only">Fechar</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({
  className,
  ...props
}: React.ComponentPropsWithRef<"div">): React.JSX.Element {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5", className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentPropsWithRef<"div"> & {
  showCloseButton?: boolean;
}): React.JSX.Element {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogClose render={<Button variant="outline" />}>Fechar</DialogClose>
      )}
    </div>
  );
}

function DialogTitle({
  className,
  ...props
}: DialogPrimitive.Title.Props): React.JSX.Element {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cnState<DialogPrimitive.Title.State>(
        "text-lg leading-none font-semibold tracking-tight",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props): React.JSX.Element {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cnState<DialogPrimitive.Description.State>(
        "text-sm text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function DialogViewport({
  className,
  ...props
}: DialogPrimitive.Viewport.Props): React.JSX.Element {
  return (
    <DialogPrimitive.Viewport
      data-slot="dialog-viewport"
      className={cnState<DialogPrimitive.Viewport.State>(
        "fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  DialogViewport,
};
