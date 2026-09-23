import type { InvitationRsvpState } from "./invitationView";

const statePresentation: Record<
  InvitationRsvpState,
  { label: string; colorClass: string }
> = {
  PENDING: {
    label: "Sem resposta",
    colorClass: "bg-admin-status-pending",
  },
  CONFIRMED: {
    label: "Irá comparecer",
    colorClass: "bg-admin-status-confirmed",
  },
  DECLINED: {
    label: "Não comparecerá",
    colorClass: "bg-admin-status-declined",
  },
};

export function InvitationStatus({ state }: { state: InvitationRsvpState }) {
  const presentation = statePresentation[state];
  return (
    <span className="inline-flex items-center gap-2 text-[0.85rem] text-admin-graphite">
      <span
        aria-hidden="true"
        className={`size-2 shrink-0 rounded-full ${presentation.colorClass}`}
      />
      {presentation.label}
    </span>
  );
}
