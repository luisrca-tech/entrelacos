import type { Input as InputPrimitive } from "@base-ui/react/input";
import { Eye, EyeOff } from "lucide-react";
import type * as React from "react";
import { useState } from "react";
import { cn } from "../lib/utils";
import { Input } from "./input";

function PasswordInput({
  className,
  disabled,
  ...props
}: Omit<InputPrimitive.Props, "type">): React.JSX.Element {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <Input
        {...props}
        disabled={disabled}
        type={visible ? "text" : "password"}
        className={
          typeof className === "function"
            ? (state) => cn("pr-11!", className(state))
            : cn("pr-11!", className)
        }
      />
      <button
        type="button"
        className="absolute top-1/2 right-1 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/25 min-h-0! h-9! w-9! p-0!"
        aria-label={visible ? "Ocultar senha" : "Mostrar senha"}
        aria-pressed={visible}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? (
          <EyeOff aria-hidden="true" className="size-4" />
        ) : (
          <Eye aria-hidden="true" className="size-4" />
        )}
      </button>
    </div>
  );
}

export { PasswordInput };
