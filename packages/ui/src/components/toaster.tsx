"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";

function Toaster({
  position = "top-center",
  richColors = true,
  ...props
}: ToasterProps) {
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

export { toast } from "sonner";
export { Toaster };
