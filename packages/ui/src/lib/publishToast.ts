export const toastEventName = "entrelacos:toast";

export type ToastKind = "success" | "error" | "warning";

export type ToastOptions = {
  action?: { label: string; onClick: () => void };
};

export type ToastDetail = ToastOptions & {
  kind: ToastKind;
  message: string;
};

export function publishToast(
  kind: ToastKind,
  message: string,
  options?: ToastOptions,
) {
  if (typeof window === "undefined" || message.length === 0) return;
  window.dispatchEvent(
    new CustomEvent<ToastDetail>(toastEventName, {
      detail: {
        kind,
        message,
        ...(options?.action ? { action: options.action } : {}),
      },
    }),
  );
}

export const toast = {
  success: (message: string, options?: ToastOptions) =>
    publishToast("success", message, options),
  error: (message: string, options?: ToastOptions) =>
    publishToast("error", message, options),
  warning: (message: string, options?: ToastOptions) =>
    publishToast("warning", message, options),
};
