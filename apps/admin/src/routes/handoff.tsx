import { handoffIssueInputSchema } from "@entrelacos/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ApiError, apiRequest } from "../lib/apiClient";
export const Route = createFileRoute("/handoff")({ component: HandoffPage });
function HandoffPage() {
  const [error, setError] = useState("");
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const input = handoffIssueInputSchema.safeParse(Object.fromEntries(query));
    if (!input.success) {
      setError(
        "Link de navegação inválido. Volte ao site e use o botão Painel.",
      );
      return;
    }
    apiRequest<{ code: string }>("/v1/handoff", {
      method: "POST",
      body: input.data,
    })
      .then(({ code }) => {
        const destination = new URL(input.data.origin);
        destination.hash = new URLSearchParams({ handoff: code }).toString();
        window.location.replace(destination.href);
      })
      .catch((cause) => {
        if (cause instanceof ApiError && cause.status === 401)
          window.location.replace(
            `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`,
          );
        else
          setError(
            cause instanceof Error
              ? cause.message
              : "Não foi possível reconhecer o acesso.",
          );
      });
  }, []);
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <h1>{error ? "Acesso indisponível" : "Abrindo seu site…"}</h1>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <a href="/">Voltar ao painel</a>
          </>
        ) : (
          <p role="status">Verificando seu acesso ao casamento.</p>
        )}
      </section>
    </main>
  );
}
