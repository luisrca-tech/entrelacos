import { type ReactNode, useEffect, useRef } from "react";
import { captureFocus, type FocusTarget, restoreFocus } from "./dialogFocus";

export const siteDialogClass =
  "m-auto w-[min(44rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl border-0 bg-[var(--template-paper,#f4f0e8)] p-[clamp(1.25rem,4vw,2.5rem)] text-template-ink [&::backdrop]:bg-[rgba(18,28,23,0.72)] [@media(max-width:560px)]:m-0 [@media(max-width:560px)]:h-dvh [@media(max-width:560px)]:max-h-none [@media(max-width:560px)]:w-screen [@media(max-width:560px)]:rounded-none";
export const siteDialogHeaderClass = "flex items-center justify-between gap-4";
export const siteDialogEyebrowClass =
  "m-0 mb-[0.8rem] text-template-muted text-[0.72rem] font-bold tracking-[0.16em] uppercase";
export const siteDialogHeadingClass =
  "m-0 text-[clamp(1.8rem,5vw,3rem)] font-normal";
export const siteDialogCloseClass =
  "w-fit cursor-pointer border-0 bg-transparent px-0 py-[0.35rem] text-template-muted underline underline-offset-[0.2rem] disabled:cursor-not-allowed disabled:opacity-50";

type SiteDialogProps = {
  open: boolean;
  labelledBy: string;
  onClose: () => void;
  children: (requestClose: () => void) => ReactNode;
};

export function SiteDialog({
  open,
  labelledBy,
  onClose,
  children,
}: SiteDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<FocusTarget | null>(null);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      opener.current = captureFocus(document.activeElement);
      node.showModal();
      const focusInitialControl = () => {
        if (node.open)
          node.querySelector<HTMLElement>("[data-dialog-initial]")?.focus();
      };
      if (typeof window.requestAnimationFrame === "function")
        window.requestAnimationFrame(focusInitialControl);
      else focusInitialControl();
    }
    if (!open && node.open) node.close();
  }, [open]);

  const handleDialogClose = () => {
    onClose();
    restoreFocus(opener.current);
    opener.current = null;
  };

  const requestClose = () => {
    if (dialog.current?.open) dialog.current.close();
    else handleDialogClose();
  };

  return (
    <dialog
      ref={dialog}
      className={siteDialogClass}
      data-lenis-prevent
      aria-labelledby={labelledBy}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClose={handleDialogClose}
    >
      {children(requestClose)}
    </dialog>
  );
}
