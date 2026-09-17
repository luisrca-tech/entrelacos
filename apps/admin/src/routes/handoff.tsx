import { handoffIssueInputSchema } from "@entrelacos/contracts";
import { Button, Card, CardContent, CardHeader } from "@entrelacos/ui";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AuthLayout } from "../components/AuthLayout";
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
        if (cause instanceof ApiError && cause.status === 401) {
          window.location.replace(
            `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`,
          );
        } else {
          setError(
            cause instanceof Error
              ? cause.message
              : "Não foi possível reconhecer o acesso.",
          );
        }
      });
  }, []);

  return (
    <AuthLayout>
      <Card className="auth-card">
        <CardHeader>
          <h1 className="auth-title">
            {error ? "Acesso indisponível" : "Abrindo seu site…"}
          </h1>
        </CardHeader>
        <CardContent>
          {error ? (
            <>
              <p role="alert">{error}</p>
              <Button
                variant="outline"
                nativeButton={false}
                render={<a href="/" />}
              >
                Voltar ao painel
              </Button>
            </>
          ) : (
            <p role="status">Verificando seu acesso ao casamento.</p>
          )}
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
