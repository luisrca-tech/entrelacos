import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type React from "react";

export function Dialog(props: DialogPrimitive.Root.Props): React.JSX.Element {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

export function DialogClose(
  props: DialogPrimitive.Close.Props,
): React.JSX.Element {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

export function DialogTitle(
  props: DialogPrimitive.Title.Props,
): React.JSX.Element {
  return <DialogPrimitive.Title data-slot="dialog-title" {...props} />;
}

export function DialogDescription(
  props: DialogPrimitive.Description.Props,
): React.JSX.Element {
  return (
    <DialogPrimitive.Description data-slot="dialog-description" {...props} />
  );
}

type DialogContentProps = DialogPrimitive.Popup.Props & {
  overlayClassName?: string;
};

export function DialogContent({
  children,
  className,
  overlayClassName,
  ...props
}: DialogContentProps): React.JSX.Element {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        data-slot="dialog-overlay"
        className={overlayClassName}
      />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={className}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}
