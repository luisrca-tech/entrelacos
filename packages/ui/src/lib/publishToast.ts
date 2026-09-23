export const toastEventName = "entrelacos:toast";

export type ToastKind = "success" | "error" | "warning";

type ToastDetail = {
  kind: ToastKind;
  message: string;
};

export function publishToast(kind: ToastKind, message: string) {
  if (typeof window === "undefined" || message.length === 0) return;
  window.dispatchEvent(
    new CustomEvent<ToastDetail>(toastEventName, {
      detail: { kind, message },
    }),
  );
}

export const toast = {
  success: (message: string) => publishToast("success", message),
  error: (message: string) => publishToast("error", message),
  warning: (message: string) => publishToast("warning", message),
};
