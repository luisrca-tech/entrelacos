import useEmblaCarousel, {
  type UseEmblaCarouselType,
} from "embla-carousel-react";
import * as React from "react";
import { cn } from "../lib/utils";

export type CarouselApi = UseEmblaCarouselType[1];
type CarouselOptions = Parameters<typeof useEmblaCarousel>[0];

type CarouselContextValue = {
  api: CarouselApi;
  carouselRef: ReturnType<typeof useEmblaCarousel>[0];
  canScrollNext: boolean;
  canScrollPrevious: boolean;
  scrollNext: () => void;
  scrollPrevious: () => void;
};

const CarouselContext = React.createContext<CarouselContextValue | null>(null);

export function useCarousel(): CarouselContextValue {
  const context = React.useContext(CarouselContext);
  if (!context) throw new Error("useCarousel must be used within Carousel");
  return context;
}

type CarouselProps = React.PropsWithChildren<
  React.HTMLAttributes<HTMLElement> & {
    options?: CarouselOptions;
    setApi?: (api: CarouselApi) => void;
  }
>;

export function Carousel({
  children,
  className,
  options,
  setApi,
  ...props
}: CarouselProps) {
  const [carouselRef, api] = useEmblaCarousel(options);
  const [canScrollPrevious, setCanScrollPrevious] = React.useState(false);
  const [canScrollNext, setCanScrollNext] = React.useState(false);

  const updateControls = React.useCallback((currentApi: CarouselApi) => {
    if (!currentApi) return;
    setCanScrollPrevious(currentApi.canScrollPrev());
    setCanScrollNext(currentApi.canScrollNext());
  }, []);

  React.useEffect(() => {
    if (!api) return;
    setApi?.(api);
    updateControls(api);
    api.on("reInit", updateControls);
    api.on("select", updateControls);
    return () => {
      api.off("reInit", updateControls);
      api.off("select", updateControls);
    };
  }, [api, setApi, updateControls]);

  const scrollPrevious = React.useCallback(() => api?.scrollPrev(), [api]);
  const scrollNext = React.useCallback(() => api?.scrollNext(), [api]);
  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        scrollPrevious();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        scrollNext();
      }
    },
    [scrollNext, scrollPrevious],
  );

  return (
    <CarouselContext.Provider
      value={{
        api,
        carouselRef,
        canScrollNext,
        canScrollPrevious,
        scrollNext,
        scrollPrevious,
      }}
    >
      <section
        role="region"
        aria-roledescription="carousel"
        data-slot="carousel"
        data-carousel-ready={api ? "true" : "false"}
        className={cn("relative", className)}
        onKeyDownCapture={handleKeyDown}
        {...props}
      >
        {children}
      </section>
    </CarouselContext.Provider>
  );
}

export function CarouselContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const { carouselRef } = useCarousel();
  return (
    <div ref={carouselRef} data-slot="carousel-content">
      <div className={cn("flex", className)} {...props} />
    </div>
  );
}

export function CarouselItem({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA carousel slides use group semantics.
    <div
      role="group"
      aria-roledescription="slide"
      data-slot="carousel-item"
      className={cn("min-w-0 shrink-0 grow-0 basis-full", className)}
      {...props}
    />
  );
}
