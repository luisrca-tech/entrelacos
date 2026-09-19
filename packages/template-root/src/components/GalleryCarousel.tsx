import {
  Carousel,
  type CarouselApi,
  CarouselContent,
  CarouselItem,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  useCarousel,
} from "@entrelacos/ui";
import React from "react";
import type { GalleryContent, Media } from "../content";

type SelectionApi = {
  off: (event: "select" | "reInit", listener: () => void) => unknown;
  on: (event: "select" | "reInit", listener: () => void) => unknown;
  selectedScrollSnap: () => number;
};

type ScrollApi = {
  scrollTo: (index: number, jump?: boolean) => unknown;
};

export function subscribeToSelectedSlide(
  api: SelectionApi,
  onSelect: (index: number) => void,
): () => void {
  const update = () => onSelect(api.selectedScrollSnap());
  update();
  api.on("select", update);
  api.on("reInit", update);
  return () => {
    api.off("select", update);
    api.off("reInit", update);
  };
}

export function syncSelectedSlide(api: ScrollApi, index: number): void {
  api.scrollTo(index, true);
}

function GalleryMedia({ media }: { media: Media }) {
  if (media.kind === "image") {
    return (
      <img
        className="block h-full w-full object-cover transition-transform duration-400 ease-linear group-hover:scale-[1.03] group-focus-within:scale-[1.03] motion-reduce:transition-none"
        src={media.src}
        alt={media.alt}
        width={media.width}
        height={media.height}
        loading="lazy"
      />
    );
  }
  return (
    <video
      className="block h-full w-full object-cover transition-transform duration-400 ease-linear group-hover:scale-[1.03] group-focus-within:scale-[1.03] motion-reduce:transition-none"
      src={media.src}
      poster={media.poster}
      width={media.width}
      height={media.height}
      muted
      loop
      playsInline
      preload="metadata"
      aria-label={media.alt}
    >
      <img
        src={media.poster}
        alt={media.alt}
        width={media.width}
        height={media.height}
        loading="lazy"
      />
    </video>
  );
}

type ControlsProps = {
  labels: GalleryContent["controls"];
  className?: string;
  compactOnTablet?: boolean;
};

function GalleryControls({
  labels,
  className = "",
  compactOnTablet = false,
}: ControlsProps) {
  const { canScrollNext, canScrollPrevious, scrollNext, scrollPrevious } =
    useCarousel();
  const responsiveNavClass = compactOnTablet
    ? "[@media(max-width:1024px)]:px-[0.6rem]"
    : "[@media(max-width:720px)]:px-3";
  const responsiveButtonClass = compactOnTablet
    ? "[@media(max-width:1024px)]:size-7 [@media(max-width:1024px)]:min-h-7 [@media(max-width:1024px)]:basis-7 [@media(max-width:1024px)]:text-[0.62rem]"
    : "[@media(max-width:720px)]:basis-11 [@media(max-width:720px)]:shrink-0";
  return (
    <nav
      className={`pointer-events-none absolute inset-x-0 top-0 z-[3] flex aspect-[4/3] items-center justify-between px-[clamp(0.75rem,2vw,1.5rem)] text-[0.72rem] uppercase tracking-[0.08em] ${responsiveNavClass} ${className}`}
      data-gallery-controls
      aria-label={labels.ariaLabel}
    >
      <button
        className={`pointer-events-auto inline-flex size-11 min-h-11 items-center justify-center border border-current bg-[rgba(244,240,232,0.88)] p-0 font-sans text-[0.72rem] uppercase tracking-[0.08em] text-template-ink backdrop-blur-[0.35rem] hover:bg-template-ink hover:text-template-ivory focus-visible:bg-template-ink focus-visible:text-template-ivory disabled:cursor-not-allowed disabled:opacity-35 ${responsiveButtonClass}`}
        type="button"
        onClick={scrollPrevious}
        disabled={!canScrollPrevious}
        aria-label={labels.previousLabel}
      >
        <span aria-hidden="true">←</span>
        <span className="sr-only">{labels.previousLabel}</span>
      </button>
      <button
        className={`pointer-events-auto inline-flex size-11 min-h-11 items-center justify-center border border-current bg-[rgba(244,240,232,0.88)] p-0 font-sans text-[0.72rem] uppercase tracking-[0.08em] text-template-ink backdrop-blur-[0.35rem] hover:bg-template-ink hover:text-template-ivory focus-visible:bg-template-ink focus-visible:text-template-ivory disabled:cursor-not-allowed disabled:opacity-35 ${responsiveButtonClass}`}
        type="button"
        onClick={scrollNext}
        disabled={!canScrollNext}
        aria-label={labels.nextLabel}
      >
        <span className="sr-only">{labels.nextLabel}</span>
        <span aria-hidden="true">→</span>
      </button>
    </nav>
  );
}

function GalleryCounter({
  current,
  total,
}: {
  current: number;
  total: number;
}) {
  return (
    <output className="mt-4 block font-inherit" aria-live="polite">
      {String(current + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}
    </output>
  );
}

type Props = {
  content: GalleryContent;
};

export default function GalleryCarousel({ content }: Props) {
  const [inlineApi, setInlineApi] = React.useState<CarouselApi>();
  const [dialogApi, setDialogApi] = React.useState<CarouselApi>();
  const [inlineSelected, setInlineSelected] = React.useState(0);
  const [dialogSelected, setDialogSelected] = React.useState(0);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const dialogInitialSlide = React.useRef(0);
  const loop = content.items.length > 1;

  React.useEffect(() => {
    if (!inlineApi) return;
    return subscribeToSelectedSlide(inlineApi, setInlineSelected);
  }, [inlineApi]);

  React.useEffect(() => {
    if (!dialogApi || !dialogOpen) return;
    syncSelectedSlide(dialogApi, dialogInitialSlide.current);
    return subscribeToSelectedSlide(dialogApi, setDialogSelected);
  }, [dialogApi, dialogOpen]);

  const openDialog = (index: number) => {
    dialogInitialSlide.current = index;
    setDialogSelected(index);
    setDialogOpen(true);
  };

  return (
    <>
      <Carousel
        options={{ align: "start", loop }}
        setApi={setInlineApi}
        className="min-w-0 [&_[data-slot=carousel-content]]:overflow-x-auto [&_[data-slot=carousel-content]]:snap-x [&_[data-slot=carousel-content]]:snap-mandatory [&_[data-slot=carousel-content]]:[scrollbar-width:none] [&_[data-slot=carousel-content]::-webkit-scrollbar]:hidden data-[carousel-ready=true]:[&_[data-slot=carousel-content]]:overflow-hidden data-[carousel-ready=true]:[&_[data-slot=carousel-content]]:snap-none"
        aria-label={content.controls.ariaLabel}
      >
        <div className="relative min-w-0" data-gallery-viewport>
          <CarouselContent className="flex">
            {content.items.map((item, index) => (
              <CarouselItem
                id={item.id}
                key={item.id}
                data-gallery-slide={index}
                aria-label={item.media.alt}
                className="min-w-0 basis-full snap-start"
              >
                <figure>
                  <div className="group relative aspect-[4/3] overflow-hidden bg-template-olive [@media(max-width:1024px)]:aspect-[4/3]">
                    <GalleryMedia media={item.media} />
                    <button
                      type="button"
                      className="absolute bottom-4 right-4 inline-flex min-h-11 translate-y-2 items-center gap-[0.6rem] border border-[rgba(244,240,232,0.72)] bg-[rgba(37,53,43,0.86)] px-[0.9rem] py-[0.65rem] font-sans text-[0.72rem] uppercase tracking-[0.08em] text-template-ivory opacity-0 transition-[opacity,transform,background-color] duration-[180ms] motion-reduce:transition-none hover:bg-template-ink focus-visible:translate-y-0 focus-visible:bg-template-ink focus-visible:opacity-100 group-hover:translate-y-0 group-hover:opacity-100 [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100 [@media(max-width:1024px)]:right-[0.65rem] [@media(max-width:1024px)]:bottom-[0.65rem] [@media(max-width:1024px)]:size-7 [@media(max-width:1024px)]:min-h-7 [@media(max-width:1024px)]:justify-center [@media(max-width:1024px)]:gap-0 [@media(max-width:1024px)]:p-0 [@media(max-width:1024px)]:text-[0.7rem] [@media(max-width:1024px)]:[&>span:not([aria-hidden])]:hidden"
                      onClick={() => openDialog(index)}
                      aria-label={`${content.controls.expandLabel}: ${item.media.alt}`}
                    >
                      <span aria-hidden="true">↗</span>
                      <span>{content.controls.expandLabel}</span>
                    </button>
                  </div>
                  {item.caption && (
                    <figcaption className="mt-3 text-[0.9rem] leading-[1.4] [@media(max-width:1024px)]:px-[var(--template-page-inset)]">
                      {item.caption}
                    </figcaption>
                  )}
                </figure>
              </CarouselItem>
            ))}
          </CarouselContent>
          <GalleryControls labels={content.controls} compactOnTablet />
        </div>
        <GalleryCounter current={inlineSelected} total={content.items.length} />
      </Carousel>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          className="fixed inset-0 z-[51] grid h-auto w-auto max-w-none translate-none grid-rows-[auto_minmax(0,1fr)] gap-4 overflow-hidden rounded-none border-0 bg-template-ink px-[clamp(1rem,3vw,2rem)] py-[clamp(1rem,3vw,2rem)] text-template-ivory shadow-none outline-none transition-none data-[starting-style]:opacity-100 [@media(max-width:720px)]:p-4"
          overlayClassName="fixed inset-0 z-[50] bg-[rgba(10,16,13,0.82)] backdrop-blur-[0.5rem] transition-none data-[starting-style]:opacity-100"
        >
          <header className="flex items-start justify-between gap-4 [@media(max-width:720px)]:items-center">
            <div>
              <DialogTitle className="m-0 block font-template-serif text-[clamp(1.5rem,3vw,2.5rem)] font-normal">
                {content.title}
              </DialogTitle>
              {content.description && (
                <DialogDescription className="mt-[0.35rem] block max-w-[42rem] text-[rgba(244,240,232,0.72)] [@media(max-width:720px)]:hidden">
                  {content.description}
                </DialogDescription>
              )}
            </div>
            <DialogClose
              className="inline-flex min-h-11 min-w-0 items-center justify-between gap-3 border border-current bg-transparent px-[0.8rem] py-[0.65rem] font-sans text-[0.72rem] uppercase tracking-[0.08em] text-inherit hover:bg-template-ink hover:text-template-ivory focus-visible:bg-template-ink focus-visible:text-template-ivory"
              aria-label={content.controls.closeLabel}
            >
              <span aria-hidden="true">×</span>
              <span>{content.controls.closeLabel}</span>
            </DialogClose>
          </header>
          <Carousel
            options={{ align: "start", loop }}
            setApi={setDialogApi}
            className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] [&_[data-slot=carousel-content]]:h-full [&_[data-slot=carousel-content]]:min-h-0 [&_[data-slot=carousel-content]]:overflow-x-auto [&_[data-slot=carousel-content]]:snap-x [&_[data-slot=carousel-content]]:snap-mandatory [&_[data-slot=carousel-content]]:[scrollbar-width:none] [&_[data-slot=carousel-content]::-webkit-scrollbar]:hidden data-[carousel-ready=true]:[&_[data-slot=carousel-content]]:overflow-hidden data-[carousel-ready=true]:[&_[data-slot=carousel-content]]:snap-none"
            aria-label={content.controls.ariaLabel}
          >
            <div className="relative min-h-0 h-full" data-gallery-viewport>
              <CarouselContent className="flex h-full min-h-0">
                {content.items.map((item, index) => (
                  <CarouselItem
                    key={item.id}
                    data-gallery-dialog-slide={index}
                    aria-label={item.media.alt}
                    className="min-h-0 h-full min-w-0 basis-full snap-start"
                  >
                    <figure className="h-full min-h-0">
                      <div className="relative h-full max-h-[calc(100svh-12rem)] overflow-hidden bg-[#111b16] aspect-auto [&_*]:!object-contain [@media(max-width:720px)]:max-h-[calc(100svh-10rem)]">
                        <GalleryMedia media={item.media} />
                      </div>
                      {item.caption && (
                        <figcaption className="mt-3 text-[0.9rem] leading-[1.4]">
                          {item.caption}
                        </figcaption>
                      )}
                    </figure>
                  </CarouselItem>
                ))}
              </CarouselContent>
              <GalleryControls
                labels={content.controls}
                className="bottom-0 h-full aspect-auto"
              />
            </div>
            <GalleryCounter
              current={dialogSelected}
              total={content.items.length}
            />
          </Carousel>
        </DialogContent>
      </Dialog>
    </>
  );
}
