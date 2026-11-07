import { AlertDialogContent, cn, DialogContent } from "@entrelacos/ui";
import type { ComponentProps } from "react";

// Keep public wedding dialogs independent from the admin's full-screen workflow.
const frame =
  "flex max-h-[calc(100dvh-48px)] max-w-[680px] flex-col gap-0 overflow-hidden rounded-2xl border-admin-line bg-admin-surface p-0 text-admin-ink shadow-admin [@media(max-width:760px)]:top-0 [@media(max-width:760px)]:left-0 [@media(max-width:760px)]:h-dvh [@media(max-width:760px)]:max-h-dvh [@media(max-width:760px)]:w-full [@media(max-width:760px)]:max-w-none [@media(max-width:760px)]:translate-x-0 [@media(max-width:760px)]:translate-y-0 [@media(max-width:760px)]:rounded-none [@media(max-width:760px)]:border-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]";
const body =
  "grid min-h-0 min-w-0 content-start gap-4 overflow-y-auto overscroll-contain p-[30px] [@media(max-width:760px)]:px-[18px] [@media(max-width:760px)]:py-6 [&_[data-slot=dialog-title]]:pr-10";

type DialogProps = ComponentProps<typeof DialogContent> & {
  scrollable?: boolean;
};

export function AdminDialogContent({
  className,
  children,
  scrollable = true,
  showCloseButton = true,
  ...props
}: DialogProps) {
  return (
    <DialogContent
      {...props}
      data-layout="responsive"
      showCloseButton={showCloseButton}
      className={(state) =>
        cn(
          frame,
          "[&>[data-slot=dialog-close]]:top-[max(12px,env(safe-area-inset-top))] [&>[data-slot=dialog-close]]:right-[max(12px,env(safe-area-inset-right))] [&>[data-slot=dialog-close]]:size-11 [&>[data-slot=dialog-close]]:bg-admin-surface",
          typeof className === "function" ? className(state) : className,
        )
      }
    >
      {scrollable ? <div className={body}>{children}</div> : children}
    </DialogContent>
  );
}

export function AdminAlertDialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof AlertDialogContent>) {
  return (
    <AlertDialogContent
      {...props}
      data-layout="responsive"
      className={(state) =>
        cn(
          frame,
          "max-w-lg",
          typeof className === "function" ? className(state) : className,
        )
      }
    >
      <div className={body}>{children}</div>
    </AlertDialogContent>
  );
}
