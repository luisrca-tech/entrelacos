import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";
import { cnState } from "../lib/utils";

function Input({
  className,
  type,
  ...props
}: InputPrimitive.Props): React.JSX.Element {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cnState<InputPrimitive.State>(
        "flex h-11 w-full min-w-0 rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground shadow-xs outline-none transition-colors file:inline-flex file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground hover:border-foreground/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
