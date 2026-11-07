import {
  Button,
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@entrelacos/ui";
import { SlidersHorizontal } from "lucide-react";
import type {
  InvitationFilters,
  InvitationGuestType,
  InvitationStatusFilter,
  InvitationSummary,
} from "./invitationView";

type Props = {
  filters: InvitationFilters;
  summary: InvitationSummary;
  onChange: (next: InvitationFilters) => void;
};

export function InvitationFiltersPopover({
  filters,
  summary,
  onChange,
}: Props) {
  const selectedCount =
    Number(filters.status !== "ALL") + Number(filters.guestType !== "ALL");
  const statusOptions: {
    value: InvitationStatusFilter;
    label: string;
    count: number;
    color?: string;
  }[] = [
    { value: "ALL", label: "Todos", count: summary.guests },
    {
      value: "PENDING",
      label: "Sem resposta",
      count: summary.pending,
      color: "bg-admin-pending",
    },
    {
      value: "CONFIRMED",
      label: "Irá comparecer",
      count: summary.confirmed,
      color: "bg-admin-success",
    },
    {
      value: "DECLINED",
      label: "Não comparecerá",
      count: summary.declined,
      color: "bg-admin-danger",
    },
  ];
  const typeOptions: {
    value: InvitationGuestType | "ALL";
    label: string;
    count: number;
  }[] = [
    { value: "ALL", label: "Todos", count: summary.guests },
    { value: "ADULT", label: "Adulto", count: summary.adults },
    { value: "CHILD", label: "Criança", count: summary.children },
  ];

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            aria-label="Filtrar convites"
            className="min-h-11 border-admin-border bg-admin-surface"
          />
        }
      >
        <SlidersHorizontal aria-hidden="true" className="size-4" />
        Filtros{selectedCount > 0 ? ` (${selectedCount})` : ""}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(320px,calc(100vw-32px))] border-admin-border bg-admin-surface p-0 text-admin-text"
      >
        <PopoverTitle className="border-b border-admin-border px-4 py-3 text-base">
          Filtrar convidados
        </PopoverTitle>
        <fieldset className="grid border-b border-admin-border px-4 pb-3">
          <legend className="mb-1 pt-3 text-[0.78rem] font-bold uppercase tracking-[0.08em] text-admin-text-secondary">
            Status
          </legend>
          {statusOptions.map((option) => (
            <label
              key={option.value}
              className="flex min-h-10 cursor-pointer items-center gap-2 text-sm"
            >
              <input
                type="radio"
                name="invitation-status-filter"
                value={option.value}
                checked={filters.status === option.value}
                onChange={() => onChange({ ...filters, status: option.value })}
                className="accent-admin-accent"
              />
              {option.color && (
                <span
                  aria-hidden="true"
                  className={`size-2 rounded-full ${option.color}`}
                />
              )}
              <span className="flex-1">{option.label}</span>
              <span className="text-admin-text-secondary">{option.count}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="grid px-4 pb-3">
          <legend className="mb-1 pt-3 text-[0.78rem] font-bold uppercase tracking-[0.08em] text-admin-text-secondary">
            Faixa etária
          </legend>
          {typeOptions.map((option) => (
            <label
              key={option.value}
              className="flex min-h-10 cursor-pointer items-center gap-2 text-sm"
            >
              <input
                type="radio"
                name="invitation-guest-type-filter"
                value={option.value}
                checked={filters.guestType === option.value}
                onChange={() =>
                  onChange({ ...filters, guestType: option.value })
                }
                className="accent-admin-accent"
              />
              <span className="flex-1">{option.label}</span>
              <span className="text-admin-text-secondary">{option.count}</span>
            </label>
          ))}
        </fieldset>
        {selectedCount > 0 && (
          <div className="border-t border-admin-border px-4 py-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                onChange({ ...filters, status: "ALL", guestType: "ALL" })
              }
            >
              Limpar filtros
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
