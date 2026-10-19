"use client";

import { useEffect } from "react";
import {
  Toaster as Sonner,
  toast as sonnerToast,
  type ToasterProps,
} from "sonner";
import { type ToastDetail, toastEventName } from "../lib/publishToast";

function Toaster({
  position = "top-center",
  richColors = true,
  ...props
}: ToasterProps) {
  useEffect(() => {
    const onToast = (event: Event) => {
      const detail = (event as CustomEvent<ToastDetail>).detail;
      if (!detail?.message) return;
      sonnerToast[detail.kind](
        detail.message,
        detail.action ? { action: detail.action } : undefined,
      );
    };
    window.addEventListener(toastEventName, onToast);
    return () => window.removeEventListener(toastEventName, onToast);
  }, []);

  return (
    <Sonner
      theme="system"
      className="entrelacos-toaster"
      position={position}
      richColors={richColors}
      toastOptions={{
        classNames: {
          toast: "entrelacos-toast",
        },
      }}
      {...props}
    />
  );
}

export { toast } from "../lib/publishToast";
export { Toaster };
