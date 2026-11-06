import type { ReactNode } from "react";

const tones = {
  success: { dot: "bg-admin-status-confirmed", text: "text-admin-success-ink" },
  pending: { dot: "bg-admin-status-pending", text: "text-admin-pending-ink" },
  neutral: { dot: "bg-admin-line-strong", text: "text-admin-muted" },
  danger: { dot: "bg-admin-status-declined", text: "text-admin-danger-ink" },
};

export function StatusSignal({
  tone,
  children,
}: {
  tone: keyof typeof tones;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 bg-transparent text-[13px] font-semibold ${tones[tone].text}`}
    >
      <span
        aria-hidden="true"
        className={`size-2 shrink-0 rounded-full ${tones[tone].dot}`}
      />
      {children}
    </span>
  );
}
