import type { ReactNode } from "react";

export function NumberedSection({
  number,
  title,
  children,
  className = "",
}: {
  number: number;
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={`m-0 grid min-w-0 gap-3 border-0 p-0 ${className}`}>
      <legend className="mb-2 flex items-center gap-2.5 text-base font-bold">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-admin-accent text-sm text-admin-on-accent">
          {number}
        </span>
        {title}
      </legend>
      {children}
    </fieldset>
  );
}
