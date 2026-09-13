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
  current: number;
  labels: GalleryContent["controls"];
  total: number;
};

function GalleryControls({ current, labels, total }: ControlsProps) {
  const { canScrollNext, canScrollPrevious, scrollNext, scrollPrevious } =
    useCarousel();
  return (
    <nav
      className="template-gallery-carousel__controls"
      data-gallery-controls
      aria-label={labels.ariaLabel}
    >
      <output className="template-gallery-carousel__counter" aria-live="polite">
        {String(current + 1).padStart(2, "0")} /{" "}
        {String(total).padStart(2, "0")}
      </output>
      <button
        type="button"
        onClick={scrollPrevious}
        disabled={!canScrollPrevious}
        aria-label={labels.previousLabel}
      >
        <span aria-hidden="true">←</span>
        <span className="template-visually-hidden">{labels.previousLabel}</span>
      </button>
      <button
        type="button"
        onClick={scrollNext}
        disabled={!canScrollNext}
        aria-label={labels.nextLabel}
      >
        <span className="template-visually-hidden">{labels.nextLabel}</span>
        <span aria-hidden="true">→</span>
      </button>
    </nav>
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
        className="template-gallery-carousel"
        aria-label={content.controls.ariaLabel}
      >
        <CarouselContent className="template-gallery-carousel__track">
          {content.items.map((item, index) => (
            <CarouselItem
              id={item.id}
              key={item.id}
              data-gallery-slide={index}
              aria-label={item.media.alt}
              className="template-gallery-carousel__slide"
            >
              <figure>
                <div className="template-gallery-carousel__frame">
                  <GalleryMedia media={item.media} />
                  <button
                    type="button"
                    className="template-gallery-carousel__expand"
                    onClick={() => openDialog(index)}
                    aria-label={`${content.controls.expandLabel}: ${item.media.alt}`}
                  >
                    <span aria-hidden="true">↗</span>
                    <span>{content.controls.expandLabel}</span>
                  </button>
                </div>
                {item.caption && <figcaption>{item.caption}</figcaption>}
              </figure>
            </CarouselItem>
          ))}
        </CarouselContent>
        <GalleryControls
          current={inlineSelected}
          labels={content.controls}
          total={content.items.length}
        />
      </Carousel>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          className="template-gallery-dialog"
          overlayClassName="template-gallery-dialog__overlay"
        >
          <header className="template-gallery-dialog__header">
            <div>
              <DialogTitle>{content.title}</DialogTitle>
              {content.description && (
                <DialogDescription>{content.description}</DialogDescription>
              )}
            </div>
            <DialogClose
              className="template-gallery-dialog__close"
              aria-label={content.controls.closeLabel}
            >
              <span aria-hidden="true">×</span>
              <span>{content.controls.closeLabel}</span>
            </DialogClose>
          </header>
          <Carousel
            options={{ align: "start", loop }}
            setApi={setDialogApi}
            className="template-gallery-carousel template-gallery-carousel--dialog"
            aria-label={content.controls.ariaLabel}
          >
            <CarouselContent className="template-gallery-carousel__track">
              {content.items.map((item, index) => (
                <CarouselItem
                  key={item.id}
                  data-gallery-dialog-slide={index}
                  aria-label={item.media.alt}
                  className="template-gallery-carousel__slide"
                >
                  <figure>
                    <div className="template-gallery-carousel__frame">
                      <GalleryMedia media={item.media} />
                    </div>
                    {item.caption && <figcaption>{item.caption}</figcaption>}
                  </figure>
                </CarouselItem>
              ))}
            </CarouselContent>
            <GalleryControls
              current={dialogSelected}
              labels={content.controls}
              total={content.items.length}
            />
          </Carousel>
        </DialogContent>
      </Dialog>
    </>
  );
}
