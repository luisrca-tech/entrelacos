import type { ComponentProps } from "react";

export function AdminSidePanel({
  className = "",
  ...props
}: ComponentProps<"aside">) {
  return (
    <aside
      className={`grid min-w-0 content-start gap-4 rounded-2xl border border-admin-line bg-admin-surface p-[22px] ${className}`}
      {...props}
    />
  );
}
