import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type * as React from "react";
import { cn, cnState } from "../lib/utils";

function Popover(props: PopoverPrimitive.Root.Props): React.JSX.Element {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger(
  props: PopoverPrimitive.Trigger.Props,
): React.JSX.Element {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

type PopoverContentProps = PopoverPrimitive.Popup.Props &
  Pick<
    PopoverPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  > & {
    positionerClassName?: string;
  };

function PopoverContent({
  className,
  positionerClassName,
  align = "center",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  ...props
}: PopoverContentProps): React.JSX.Element {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className={cnState<PopoverPrimitive.Positioner.State>(
          "z-50",
          positionerClassName,
        )}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cnState<PopoverPrimitive.Popup.State>(
            "z-50 w-72 origin-(--transform-origin) rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg outline-none transition-opacity data-[starting-style]:opacity-0",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function PopoverHeader({
  className,
  ...props
}: React.ComponentPropsWithRef<"div">): React.JSX.Element {
  return (
    <div
      data-slot="popover-header"
      className={cn("mb-3 flex flex-col gap-1", className)}
      {...props}
    />
  );
}

function PopoverTitle({
  className,
  ...props
}: PopoverPrimitive.Title.Props): React.JSX.Element {
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      className={cnState<PopoverPrimitive.Title.State>(
        "text-sm font-semibold",
        className,
      )}
      {...props}
    />
  );
}

function PopoverDescription({
  className,
  ...props
}: PopoverPrimitive.Description.Props): React.JSX.Element {
  return (
    <PopoverPrimitive.Description
      data-slot="popover-description"
      className={cnState<PopoverPrimitive.Description.State>(
        "text-sm text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function PopoverClose(props: PopoverPrimitive.Close.Props): React.JSX.Element {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

export {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
};
