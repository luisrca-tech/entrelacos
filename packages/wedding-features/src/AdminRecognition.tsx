import { useCallback, useEffect, useState } from "react";
import {
  createRecognitionChallenge,
  panelHandoffUrl,
} from "./adminRecognition";

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
        "Não foi possível abrir o painel neste navegador. Tente novamente.",
      );
    }
  }, [panelOrigin, siteId, verifierKey]);
  useEffect(() => {
    let active = true;
    let running = false;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const code = fragment.get("handoff");
    const fromPanel = window.location.hash === "#panel";
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
        await enterPanel();
        return;
      }
      if (code) {
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
              "Acesso administrativo não reconhecido. Use Painel para entrar novamente.",
            );
        }
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
  return (
    <aside
      aria-label="Acesso administrativo"
      style={{
        padding: "16px 24px",
        background: "#e8e3d8",
        color: "#25352b",
        display: "flex",
        flexWrap: "wrap",
        gap: "16px",
        alignItems: "center",
      }}
    >
      {recognized && <span role="status">Modo administrador</span>}
      {recognized ? (
        <a href={`${panelOrigin}/sites/${encodeURIComponent(siteId)}`}>
          Voltar ao painel
        </a>
      ) : (
        <a
          href={`${panelOrigin}/sites/${encodeURIComponent(siteId)}`}
          style={{ padding: "10px 16px", minHeight: "44px", cursor: "pointer" }}
        >
          Painel
        </a>
      )}
      {error && <p role="alert">{error}</p>}
    </aside>
  );
}
