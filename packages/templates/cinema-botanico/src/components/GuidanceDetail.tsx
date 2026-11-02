import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@entrelacos/ui";
import type { GuidanceDetail as GuidanceDetailContent } from "../content";

type GuidanceDetailProps = {
  detail: GuidanceDetailContent;
  titleId: string;
};

export default function GuidanceDetail({
  detail,
  titleId,
}: GuidanceDetailProps) {
  return (
    <Dialog>
      <DialogTrigger className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-[0.62rem] font-medium uppercase tracking-[0.08em] text-inherit">
        {detail.label}
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m6 17 5-5-5-5" />
          <path d="m13 17 5-5-5-5" />
        </svg>
      </DialogTrigger>
      <DialogContent
        data-lenis-prevent
        className="max-h-[calc(100dvh-1rem)] w-[min(62rem,calc(100vw-2rem))] max-w-none overflow-y-auto bg-template-ivory p-4 text-template-ink"
      >
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <DialogTitle
              id={titleId}
              className="m-0 font-template-serif text-[clamp(1.6rem,3vw,2.2rem)] font-normal tracking-[-0.03em]"
            >
              {detail.title}
            </DialogTitle>
            <DialogDescription className="mt-1 max-w-[36rem] text-base leading-[1.6] text-template-muted">
              {detail.body}
            </DialogDescription>
          </div>
          <DialogClose
            className="inline-flex min-h-11 items-center gap-2 border border-template-line bg-transparent px-3 text-[0.72rem] uppercase tracking-[0.08em] text-template-ink"
            aria-label={detail.closeLabel}
          >
            <span aria-hidden="true">×</span>
            <span>{detail.closeLabel}</span>
          </DialogClose>
        </header>
        <img
          className="mx-auto block h-auto max-h-[min(52rem,82vh)] w-[min(34rem,86%)] object-contain"
          src={detail.media.src}
          alt={detail.media.alt}
          width={detail.media.width}
          height={detail.media.height}
        />
      </DialogContent>
    </Dialog>
  );
}
