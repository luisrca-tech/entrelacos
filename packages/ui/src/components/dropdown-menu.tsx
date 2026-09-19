import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type * as React from "react";
import { cn, cnState } from "../lib/utils";

function DropdownMenu(props: MenuPrimitive.Root.Props): React.JSX.Element {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger(
  props: MenuPrimitive.Trigger.Props,
): React.JSX.Element {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

type DropdownMenuContentProps = MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  > & {
    positionerClassName?: string;
  };

function DropdownMenuContent({
  className,
  positionerClassName,
  align = "end",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  ...props
}: DropdownMenuContentProps): React.JSX.Element {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className={cnState<MenuPrimitive.Positioner.State>(
          "z-50",
          positionerClassName,
        )}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cnState<MenuPrimitive.Popup.State>(
            "z-50 min-w-40 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none transition-opacity motion-reduce:transition-none data-[starting-style]:opacity-0",
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  variant?: "default" | "destructive";
}): React.JSX.Element {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cnState<MenuPrimitive.Item.State>(
        cn(
          "relative flex min-h-9 cursor-default items-center rounded-md px-2 py-1.5 text-sm outline-none select-none data-[highlighted]:bg-secondary data-[highlighted]:text-secondary-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
          variant === "destructive" &&
            "text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive",
        ),
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: MenuPrimitive.Separator.Props): React.JSX.Element {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cnState<MenuPrimitive.Separator.State>(
        "my-1 h-px bg-border",
        className,
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
};
