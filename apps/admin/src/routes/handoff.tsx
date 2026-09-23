import { handoffIssueInputSchema } from "@entrelacos/contracts";
import { Button, Card, CardContent, CardHeader, toast } from "@entrelacos/ui";
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
      const message =
        "Link de navegação inválido. Volte ao site e use o botão Painel.";
      toast.error(message);
      setError(message);
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
          const message =
            cause instanceof Error
              ? cause.message
              : "Não foi possível reconhecer o acesso.";
          toast.error(message);
          setError(message);
        }
      });
  }, []);

  return (
    <AuthLayout>
      <Card className="w-full max-w-[480px] mx-auto border-0 bg-transparent shadow-none [&_[data-slot=card-header]]:p-0 [&_[data-slot=card-content]]:p-0">
        <CardHeader>
          <h1 className="m-0 max-w-[780px] font-admin-display text-[clamp(2.4rem,5vw,4rem)] font-normal leading-[1.04] tracking-[-0.025em]">
            {error ? "Acesso indisponível" : "Abrindo seu site…"}
          </h1>
        </CardHeader>
        <CardContent>
          {error ? (
            <Button
              variant="outline"
              nativeButton={false}
              render={<a href="/" />}
            >
              Voltar ao painel
            </Button>
          ) : (
            <p className="leading-[1.6]" role="status">
              Verificando seu acesso ao casamento.
            </p>
          )}
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
