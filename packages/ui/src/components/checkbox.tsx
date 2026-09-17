import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Check, Minus } from "lucide-react";
import type * as React from "react";
import { cnState } from "../lib/utils";

function Checkbox({
  className,
  ...props
}: CheckboxPrimitive.Root.Props): React.JSX.Element {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cnState<CheckboxPrimitive.Root.State>(
        "relative inline-flex size-5 shrink-0 items-center justify-center rounded border border-input bg-card text-primary outline-none transition-colors hover:border-foreground/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 data-[disabled]:pointer-events-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 aria-disabled:pointer-events-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50 data-[checked]:border-primary data-[checked]:bg-primary data-[checked]:text-primary-foreground data-[indeterminate]:border-primary data-[indeterminate]:bg-primary data-[indeterminate]:text-primary-foreground aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="group/checkbox-indicator inline-flex items-center justify-center"
      >
        <Check
          aria-hidden="true"
          className="size-4 group-data-[indeterminate]/checkbox-indicator:hidden"
        />
        <Minus
          aria-hidden="true"
          className="hidden size-4 group-data-[indeterminate]/checkbox-indicator:block"
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
