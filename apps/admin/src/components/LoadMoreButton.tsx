import { Button } from "@entrelacos/ui";
import { useCallback, useEffect, useRef } from "react";

export function LoadMoreButton({
  cursor,
  onLoad,
  loading = false,
  disabled = false,
  manualOnly = false,
  label = "Carregar mais",
  className,
}: {
  cursor: string | null;
  onLoad: (cursor: string) => Promise<unknown> | undefined;
  loading?: boolean;
  disabled?: boolean;
  manualOnly?: boolean;
  label?: string;
  className?: string;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const latestLoad = useRef(onLoad);
  latestLoad.current = onLoad;

  const load = useCallback(async () => {
    if (!cursor || loading || disabled || inFlight.current) return;
    inFlight.current = true;
    try {
      await latestLoad.current(cursor);
    } finally {
      inFlight.current = false;
    }
  }, [cursor, disabled, loading]);

  useEffect(() => {
    if (
      !cursor ||
      loading ||
      disabled ||
      manualOnly ||
      !button.current ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!active || !entries.some((entry) => entry.isIntersecting)) return;
        active = false;
        observer.disconnect();
        void load();
      },
      { rootMargin: "160px" },
    );
    observer.observe(button.current);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [cursor, disabled, load, loading, manualOnly]);

  if (!cursor) return null;
  return (
    <Button
      ref={button}
      type="button"
      variant="outline"
      className={className}
      disabled={disabled || loading}
      aria-busy={loading}
      onClick={() => void load()}
    >
      {loading ? "Carregando mais…" : label}
    </Button>
  );
}
