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
      setError(
        "Não foi possível iniciar o acesso administrativo neste navegador. Tente novamente.",
      );
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
            if (active)
              setError(
                "Acesso administrativo não reconhecido. Tente novamente a partir do ambiente administrativo.",
              );
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
  if (view === "hidden") return null;
  return (
    <>
      <aside className="admin-recognition" aria-label="Acesso administrativo">
        {view === "recognized" && (
          <a
            ref={panelLink}
            className="admin-recognition__link"
            href={`${panelOrigin}/sites/${encodeURIComponent(siteId)}`}
          >
            {adminPanelLinkLabel}
          </a>
        )}
        {error && <p role="alert">{error}</p>}
      </aside>
      {showIntro &&
        typeof document !== "undefined" &&
        createPortal(
          <aside
            className="admin-intro"
            role="dialog"
            aria-modal="false"
            aria-labelledby="entrelacos-admin-intro-title"
            aria-describedby="entrelacos-admin-intro-body"
          >
            <div>
              <h2 id="entrelacos-admin-intro-title">{adminIntroTitle}</h2>
              <p id="entrelacos-admin-intro-body">{adminIntroBody}</p>
            </div>
            <button
              ref={confirmButton}
              type="button"
              className="admin-intro__confirm"
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
