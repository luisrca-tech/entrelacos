import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@entrelacos/ui";
import { MoreHorizontal } from "lucide-react";
import { AdminButton } from "./AdminButton";

export type OverflowMenuItem = {
  id: string;
  label: string;
  variant?: "default" | "destructive";
  disabled?: boolean;
};

export function OverflowMenu({
  label,
  items,
  disabled,
  onSelect,
}: {
  label: string;
  items: OverflowMenuItem[];
  disabled?: boolean;
  onSelect: (id: string) => void;
}) {
  if (items.length === 0) return null;
  const rest = items.filter((item) => item.variant !== "destructive");
  const destructive = items.filter((item) => item.variant === "destructive");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <AdminButton
            type="button"
            tone="ghost"
            size="icon-sm"
            className="size-8 text-admin-text-secondary"
            aria-label={label}
          />
        }
      >
        <MoreHorizontal aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {rest.map((item) => (
          <DropdownMenuItem
            key={item.id}
            disabled={disabled || item.disabled}
            onClick={() => onSelect(item.id)}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
        {destructive.length > 0 && rest.length > 0 && <DropdownMenuSeparator />}
        {destructive.map((item) => (
          <DropdownMenuItem
            key={item.id}
            variant="destructive"
            disabled={disabled || item.disabled}
            onClick={() => onSelect(item.id)}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
