export const adminStyles = {
  alert:
    "break-words rounded-[9px] border border-[rgb(142_58_42_/_30%)] bg-admin-terracotta-wash px-3.5 py-3 leading-[1.6] text-admin-terracotta-deep",
  card: "my-6 rounded-[14px] border border-admin-line bg-admin-surface p-[26px] shadow-none",
  form: "my-7 grid gap-[18px] [&_label]:grid [&_label]:gap-2 [&_label]:text-[0.88rem] [&_label]:font-[650] [&_label]:text-admin-graphite [&_input]:min-h-11 [&_input]:min-w-0 [&_input]:w-full [&_input]:rounded-lg [&_input]:border [&_input]:border-admin-line [&_input]:bg-admin-surface [&_input]:px-3 [&_input]:py-2.5 [&_input]:text-admin-ink [&_input:focus]:border-admin-terracotta [&_input:focus]:outline-[3px] [&_input:focus]:outline-[rgb(168_77_57_/_20%)] [&_input:focus]:outline-offset-2 [&_select]:min-h-11 [&_select]:w-full [&_select]:rounded-lg [&_select]:border [&_select]:border-admin-line [&_select]:bg-admin-surface [&_select]:px-3 [&_select]:py-2.5 [&_select:focus]:border-admin-terracotta [&_select:focus]:outline-[3px] [&_select:focus]:outline-[rgb(168_77_57_/_20%)] [&_select:focus]:outline-offset-2 [&_textarea]:min-h-11 [&_textarea]:w-full [&_textarea]:rounded-lg [&_textarea]:border [&_textarea]:border-admin-line [&_textarea]:bg-admin-surface [&_textarea]:px-3 [&_textarea]:py-2.5 [&_textarea:focus]:border-admin-terracotta [&_textarea:focus]:outline-[3px] [&_textarea:focus]:outline-[rgb(168_77_57_/_20%)] [&_textarea:focus]:outline-offset-2 [&_button]:w-fit [&_button]:min-h-[42px] [&_button]:px-[17px] [&_button]:py-2.5 [&_[data-slot=button]]:w-fit",
  formGrid:
    "my-7 grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] items-end gap-[18px] [&_label]:grid [&_label]:gap-2 [&_label]:text-[0.88rem] [&_label]:font-[650] [&_label]:text-admin-graphite [&_input]:min-h-11 [&_input]:min-w-0 [&_input]:w-full [&_input]:rounded-lg [&_input]:border [&_input]:border-admin-line [&_input]:bg-admin-surface [&_input]:px-3 [&_input]:py-2.5 [&_input]:text-admin-ink [&_input:focus]:border-admin-terracotta [&_input:focus]:outline-[3px] [&_input:focus]:outline-[rgb(168_77_57_/_20%)] [&_input:focus]:outline-offset-2 [&_textarea]:min-h-11 [&_textarea]:min-w-0 [&_textarea]:w-full [&_textarea]:rounded-lg [&_textarea]:border [&_textarea]:border-admin-line [&_textarea]:bg-admin-surface [&_textarea]:px-3 [&_textarea]:py-2.5 [&_textarea:focus]:border-admin-terracotta [&_textarea:focus]:outline-[3px] [&_textarea:focus]:outline-[rgb(168_77_57_/_20%)] [&_textarea:focus]:outline-offset-2 [&_button]:w-fit [&_button]:min-h-[42px] [&_button]:px-[17px] [&_button]:py-2.5 [&_[data-slot=button]]:w-fit",
  authForm:
    "my-[34px] mb-[22px] grid gap-[18px] [&_label]:font-[650] [&_input]:min-h-11 [&_input]:min-w-0 [&_input]:w-full [&_input]:rounded-lg [&_input]:border [&_input]:border-admin-line [&_input]:bg-admin-surface [&_input]:px-3 [&_input]:py-2.5 [&_input]:text-admin-ink [&_input:focus]:border-admin-terracotta [&_input:focus]:outline-[3px] [&_input:focus]:outline-[rgb(168_77_57_/_20%)] [&_input:focus]:outline-offset-2 [&_button]:w-fit [&_button]:min-h-[42px] [&_button]:px-[17px] [&_button]:py-2.5 [&_[data-slot=button]]:w-fit",
  inline: "flex flex-wrap items-center gap-3.5",
  notice:
    "border-l-[3px] border-admin-terracotta bg-admin-beige px-[18px] py-4 leading-[1.6] text-admin-graphite",
  muted: "text-admin-muted",
  checkbox: "flex items-center gap-2.5",
  dialog:
    "max-h-[calc(100vh-32px)] max-w-[min(680px,calc(100vw-32px))] overflow-y-auto rounded-2xl border border-admin-line bg-admin-surface p-[30px] shadow-admin max-[760px]:p-6 max-[760px]:px-[18px]",
  groupCard:
    "items-stretch rounded-[10px] border border-admin-line bg-admin-beige p-5 [&_[data-slot=card-header]]:w-full [&_h3]:mb-2",
} as const;

export const displayHeading =
  "font-admin-display font-normal leading-[1.08] tracking-[-0.025em]";
