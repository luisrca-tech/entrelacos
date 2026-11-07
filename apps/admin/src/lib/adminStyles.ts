export const adminStyles = {
  alert:
    "break-words rounded-[9px] border border-admin-accent-hover/30 bg-admin-accent-subtle px-3.5 py-3 leading-[1.6] text-admin-accent-hover",
  card: "my-6 rounded-[14px] border border-admin-border bg-admin-surface p-[26px] shadow-none",
  surface:
    "rounded-2xl border border-admin-border bg-admin-surface shadow-none",
  form: "my-7 grid gap-[18px] [&_label]:grid [&_label]:gap-2 [&_label]:text-[0.88rem] [&_label]:font-[650] [&_label]:text-admin-text [&_input]:min-h-11 [&_input]:min-w-0 [&_input]:w-full [&_input]:rounded-lg [&_input]:border [&_input]:border-admin-border [&_input]:bg-admin-surface [&_input]:px-3 [&_input]:py-2.5 [&_input]:text-admin-text [&_input:focus]:border-admin-accent [&_input:focus]:outline-[3px] [&_input:focus]:outline-admin-accent/20 [&_input:focus]:outline-offset-2 [&_select]:min-h-11 [&_select]:w-full [&_select]:rounded-lg [&_select]:border [&_select]:border-admin-border [&_select]:bg-admin-surface [&_select]:px-3 [&_select]:py-2.5 [&_select:focus]:border-admin-accent [&_select:focus]:outline-[3px] [&_select:focus]:outline-admin-accent/20 [&_select:focus]:outline-offset-2 [&_textarea]:min-h-11 [&_textarea]:w-full [&_textarea]:rounded-lg [&_textarea]:border [&_textarea]:border-admin-border [&_textarea]:bg-admin-surface [&_textarea]:px-3 [&_textarea]:py-2.5 [&_textarea:focus]:border-admin-accent [&_textarea:focus]:outline-[3px] [&_textarea:focus]:outline-admin-accent/20 [&_textarea:focus]:outline-offset-2 [&_button]:w-fit [&_button]:min-h-[42px] [&_button]:px-[17px] [&_button]:py-2.5 [&_[data-slot=button]]:w-fit",
  formGrid:
    "my-7 grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] items-end gap-[18px] [&_label]:grid [&_label]:gap-2 [&_label]:text-[0.88rem] [&_label]:font-[650] [&_label]:text-admin-text [&_input]:min-h-11 [&_input]:min-w-0 [&_input]:w-full [&_input]:rounded-lg [&_input]:border [&_input]:border-admin-border [&_input]:bg-admin-surface [&_input]:px-3 [&_input]:py-2.5 [&_input]:text-admin-text [&_input:focus]:border-admin-accent [&_input:focus]:outline-[3px] [&_input:focus]:outline-admin-accent/20 [&_input:focus]:outline-offset-2 [&_textarea]:min-h-11 [&_textarea]:min-w-0 [&_textarea]:w-full [&_textarea]:rounded-lg [&_textarea]:border [&_textarea]:border-admin-border [&_textarea]:bg-admin-surface [&_textarea]:px-3 [&_textarea]:py-2.5 [&_textarea:focus]:border-admin-accent [&_textarea:focus]:outline-[3px] [&_textarea:focus]:outline-admin-accent/20 [&_textarea:focus]:outline-offset-2 [&_button]:w-fit [&_button]:min-h-[42px] [&_button]:px-[17px] [&_button]:py-2.5 [&_[data-slot=button]]:w-fit",
  authForm:
    "grid gap-[18px] [&_label]:text-sm [&_label]:font-semibold [&_input]:h-12 [&_input]:rounded-[10px] [&_input]:border-admin-border-strong [&_input]:bg-admin-surface [&_input]:px-3.5 [&_input:focus]:border-admin-accent [&_input:focus]:ring-admin-accent/20",
  authEyebrow:
    "m-0 text-[11px] font-bold uppercase tracking-[0.13em] text-admin-accent-hover",
  authError:
    "m-0 rounded-[10px] border border-admin-danger bg-admin-danger-subtle px-3.5 py-3 text-sm leading-relaxed text-admin-danger-text",
  authHeading:
    "m-0 font-admin-display text-[36px] font-normal leading-[1.06] tracking-tight lg:text-[44px]",
  dangerButton:
    "min-h-12 rounded-[10px] border-transparent bg-admin-danger px-6 font-bold text-admin-on-accent hover:bg-admin-danger-text",
  authButton:
    "h-12 w-full rounded-[10px] bg-admin-accent font-bold text-admin-on-accent hover:bg-admin-accent-hover",
  inline: "flex flex-wrap items-center gap-3.5",
  selected:
    "bg-admin-accent-subtle text-admin-accent-hover hover:bg-admin-accent-subtle hover:text-admin-accent-hover",
  notice:
    "border-l-[3px] border-admin-accent bg-admin-subtle px-[18px] py-4 leading-[1.6] text-admin-text",
  muted: "text-admin-text-secondary",
  checkbox: "flex! items-center gap-2",
  groupCard:
    "items-stretch rounded-[10px] border border-admin-border bg-admin-subtle p-5 [&_[data-slot=card-header]]:w-full [&_h3]:mb-2",
} as const;

export const displayHeading =
  "font-admin-display font-normal leading-[1.08] tracking-[-0.025em]";
