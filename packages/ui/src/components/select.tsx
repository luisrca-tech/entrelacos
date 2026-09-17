import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import type * as React from "react";
import { cn, cnState } from "../lib/utils";

const Select = SelectPrimitive.Root;

function SelectGroup({
  className,
  ...props
}: SelectPrimitive.Group.Props): React.JSX.Element {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cnState<SelectPrimitive.Group.State>(
        "overflow-hidden p-1",
        className,
      )}
      {...props}
    />
  );
}

function SelectValue({
  className,
  ...props
}: SelectPrimitive.Value.Props): React.JSX.Element {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cnState<SelectPrimitive.Value.State>(
        "line-clamp-1 flex items-center gap-1",
        className,
      )}
      {...props}
    />
  );
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: SelectPrimitive.Trigger.Props & {
  size?: "sm" | "default";
}): React.JSX.Element {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cnState<SelectPrimitive.Trigger.State>(
        cn(
          "flex w-full items-center justify-between gap-2 rounded-lg border border-input bg-card px-3 text-sm text-foreground shadow-xs outline-none transition-colors hover:border-foreground/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
          size === "sm" ? "h-10" : "h-11",
        ),
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="shrink-0 text-muted-foreground">
        <ChevronDown aria-hidden="true" className="size-4" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

type SelectContentProps = SelectPrimitive.Popup.Props &
  Pick<
    SelectPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger"
  > & {
    positionerClassName?: string;
  };

function SelectContent({
  className,
  positionerClassName,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  alignItemWithTrigger = true,
  ...props
}: SelectContentProps): React.JSX.Element {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        className={cnState<SelectPrimitive.Positioner.State>(
          "z-50",
          positionerClassName,
        )}
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cnState<SelectPrimitive.Popup.State>(
            "relative z-50 max-h-(--available-height) w-(--anchor-width) min-w-32 overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none transition-opacity data-[starting-style]:opacity-0",
            className,
          )}
          {...props}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({
  className,
  ...props
}: SelectPrimitive.GroupLabel.Props): React.JSX.Element {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cnState<SelectPrimitive.GroupLabel.State>(
        "px-2 py-1.5 text-xs font-semibold text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function SelectItem({
  className,
  children,
  ...props
}: SelectPrimitive.Item.Props): React.JSX.Element {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cnState<SelectPrimitive.Item.State>(
        "relative flex min-h-11 w-full cursor-default items-center rounded-md py-2 pr-8 pl-2 text-sm outline-none select-none data-[highlighted]:bg-secondary data-[highlighted]:text-secondary-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="min-w-0 flex-1 truncate">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2 inline-flex items-center">
        <Check aria-hidden="true" className="size-4" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: SelectPrimitive.Separator.Props): React.JSX.Element {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cnState<SelectPrimitive.Separator.State>(
        "my-1 h-px bg-border",
        className,
      )}
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: SelectPrimitive.ScrollUpArrow.Props): React.JSX.Element {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cnState<SelectPrimitive.ScrollUpArrow.State>(
        "flex h-6 w-full items-center justify-center",
        className,
      )}
      {...props}
    >
      <ChevronUp aria-hidden="true" className="size-4" />
    </SelectPrimitive.ScrollUpArrow>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: SelectPrimitive.ScrollDownArrow.Props): React.JSX.Element {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cnState<SelectPrimitive.ScrollDownArrow.State>(
        "flex h-6 w-full items-center justify-center",
        className,
      )}
      {...props}
    >
      <ChevronDown aria-hidden="true" className="size-4" />
    </SelectPrimitive.ScrollDownArrow>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
