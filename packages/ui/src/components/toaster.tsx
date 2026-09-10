"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";

function Toaster({ ...props }: ToasterProps) {
  return (
    <Sonner
      theme="system"
      className="entrelacos-toaster"
      toastOptions={{
        classNames: {
          toast: "entrelacos-toast",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
