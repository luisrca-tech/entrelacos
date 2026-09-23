import { toast } from "@entrelacos/ui/toaster";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  adminIntroBody,
  adminIntroConfirmLabel,
  adminIntroTitle,
  adminPanelLinkLabel,
  createRecognitionChallenge,
  getAdminRecognitionView,
  panelHandoffUrl,
  readAdminIntroDismissed,
  runAdminHandoffOnce,
  shouldShowAdminIntro,
  writeAdminIntroDismissed,
} from "./adminRecognition";

function localAdminIntroStorage() {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function AdminRecognition({
  siteId,
  apiOrigin,
  panelOrigin,
}: {
  siteId: string;
  apiOrigin: string;
  panelOrigin: string;
}) {
  const [recognized, setRecognized] = useState(false);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState(() =>
    readAdminIntroDismissed(localAdminIntroStorage(), siteId),
  );
  const confirmButton = useRef<HTMLButtonElement>(null);
  const panelLink = useRef<HTMLAnchorElement>(null);
  const initialFragment = useRef("");
  if (typeof window !== "undefined" && !initialFragment.current) {
    initialFragment.current = window.location.hash;
  }
  const verifierKey = `entrelacos:admin-verifier:${siteId}`;
  const tokenKey = `entrelacos:recognition:${siteId}`;
  const enterPanel = useCallback(async () => {
    try {
      const { verifier, challenge } = await createRecognitionChallenge();
      const url = panelHandoffUrl(
        panelOrigin,
        siteId,
        window.location.origin,
        challenge,
      );
      sessionStorage.setItem(verifierKey, verifier);
      window.location.assign(url);
    } catch {
      const message =
        "Não foi possível iniciar o acesso administrativo neste navegador. Tente novamente.";
      toast.error(message);
      setError(message);
    }
  }, [panelOrigin, siteId, verifierKey]);
  const dismissIntro = useCallback(() => {
    writeAdminIntroDismissed(localAdminIntroStorage(), siteId);
    panelLink.current?.focus();
    setDismissed(true);
  }, [siteId]);
  useEffect(() => {
    let active = true;
    let running = false;
    const fragment = new URLSearchParams(initialFragment.current.slice(1));
    const code = fragment.get("handoff");
    const fromPanel = initialFragment.current === "#panel";
    if (code || fromPanel)
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    async function request(path: string, data: Record<string, string>) {
      const response = await fetch(`${apiOrigin}/v1/handoff/${path}`, {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteId,
          origin: window.location.origin,
          ...data,
        }),
      });
      if (!response.ok) throw new Error("Recognition rejected");
      return response.json();
    }
    async function check() {
      if (running || !active) return;
      running = true;
      try {
        const token = sessionStorage.getItem(tokenKey);
        if (!token) {
          if (active) setRecognized(false);
          return;
        }
        const result = await request("recognize", { recognitionToken: token });
        if (active) setRecognized(result.recognized === true);
        if (!result.recognized) sessionStorage.removeItem(tokenKey);
      } catch {
        if (active) setRecognized(false);
      } finally {
        running = false;
      }
    }
    async function start() {
      if (fromPanel) {
        await runAdminHandoffOnce(siteId, window.location.origin, enterPanel);
        return;
      }
      if (code) {
        await runAdminHandoffOnce(siteId, window.location.origin, async () => {
          try {
            const verifier = sessionStorage.getItem(verifierKey);
            sessionStorage.removeItem(verifierKey);
            if (!verifier) throw new Error("Missing verifier");
            const result = await request("redeem", { code, verifier });
            sessionStorage.setItem(tokenKey, result.recognitionToken);
          } catch {
            sessionStorage.removeItem(tokenKey);
            if (active) {
              const message =
                "Acesso administrativo não reconhecido. Tente novamente a partir do ambiente administrativo.";
              toast.error(message);
              setError(message);
            }
          }
        });
      }
      await check();
    }
    void start();
    const interval = window.setInterval(() => {
      void check();
    }, 5000);
    const visible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [siteId, apiOrigin, enterPanel, verifierKey, tokenKey]);
  const view = getAdminRecognitionView(recognized, error);
  const showIntro = shouldShowAdminIntro(recognized, dismissed);
  useEffect(() => {
    if (!showIntro) return;
    confirmButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismissIntro();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [showIntro, dismissIntro]);
  if (view !== "recognized") return null;
  return (
    <>
      <aside
        className="flex flex-wrap items-center gap-3 text-inherit"
        aria-label="Acesso administrativo"
      >
        <a
          ref={panelLink}
          className="inline-flex min-h-11 items-center px-1 py-2 text-inherit no-underline hover:underline hover:underline-offset-4 focus-visible:underline focus-visible:underline-offset-4"
          href={`${panelOrigin}/sites/${encodeURIComponent(siteId)}`}
        >
          {adminPanelLinkLabel}
        </a>
      </aside>
      {showIntro &&
        typeof document !== "undefined" &&
        createPortal(
          <aside
            className="fixed inset-x-0 bottom-0 z-40 flex flex-wrap items-end justify-between gap-4 bg-template-ivory px-[var(--template-page-inset,1.5rem)] py-4 text-template-ink shadow-[0_-0.75rem_2rem_rgba(37,53,43,0.16)] normal-case tracking-normal animate-admin-intro-enter motion-reduce:animate-none"
            role="dialog"
            aria-modal="false"
            aria-labelledby="entrelacos-admin-intro-title"
            aria-describedby="entrelacos-admin-intro-body"
          >
            <div>
              <h2
                className="m-0 font-template-serif text-[1.2rem] font-normal tracking-[-0.03em]"
                id="entrelacos-admin-intro-title"
              >
                {adminIntroTitle}
              </h2>
              <p
                className="mt-[0.4rem] mb-0 max-w-[36rem] text-template-muted text-[0.92rem] leading-[1.5]"
                id="entrelacos-admin-intro-body"
              >
                {adminIntroBody}
              </p>
            </div>
            <button
              ref={confirmButton}
              type="button"
              className="min-h-11 cursor-pointer border border-template-ink bg-template-ink px-4 py-[0.65rem] text-template-ivory font-[inherit] font-bold"
              onClick={dismissIntro}
            >
              {adminIntroConfirmLabel}
            </button>
          </aside>,
          document.body,
        )}
    </>
  );
}
