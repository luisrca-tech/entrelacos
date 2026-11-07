import type { ReactNode } from "react";

const tones = {
  success: { dot: "bg-admin-success", text: "text-admin-success-text" },
  pending: { dot: "bg-admin-pending", text: "text-admin-pending-text" },
  neutral: { dot: "bg-admin-border-strong", text: "text-admin-text-secondary" },
  danger: { dot: "bg-admin-danger", text: "text-admin-danger-text" },
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
