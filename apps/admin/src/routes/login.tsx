import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  Input,
} from "@entrelacos/ui";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { AuthLayout } from "../components/AuthLayout";
import { apiRequest, safePanelReturn } from "../lib/apiClient";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    email: typeof search.email === "string" ? search.email : "",
    next: safePanelReturn(search.next),
  }),
  component: LoginPage,
});

function LoginPage() {
  const search = Route.useSearch();
  const [error, setError] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => setHydrated(true), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    try {
      await apiRequest("/v1/auth/sign-in/email", {
        method: "POST",
        body: { email: form.get("email"), password: form.get("password") },
      });
      window.location.assign(search.next);
    } catch {
      setError(
        "Não foi possível entrar. Confira o e-mail e a senha ou solicite um novo acesso ao responsável.",
      );
      setPending(false);
    }
  }

  return (
    <AuthLayout>
      <Card className="auth-card" aria-labelledby="login-title">
        <CardHeader>
          <p className="eyebrow">Acesso ao painel</p>
          <h1 className="auth-title" id="login-title">
            Bem-vindo de volta.
          </h1>
          <CardDescription>
            Entre com o acesso recebido do responsável pelo seu casamento.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="data-form" method="post" onSubmit={submit}>
            <label htmlFor="login-email">
              E-mail
              <Input
                id="login-email"
                name="email"
                type="email"
                autoComplete="username"
                defaultValue={search.email}
                required
                maxLength={320}
              />
            </label>
            <label htmlFor="login-password">
              Senha
              <Input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={200}
              />
            </label>
            {error && <p role="alert">{error}</p>}
            <Button
              type="submit"
              data-login-ready={hydrated ? "true" : undefined}
              disabled={!hydrated || pending}
            >
              {pending ? "Entrando…" : "Entrar"}
            </Button>
          </form>
          <p className="help-text">
            Esqueceu a senha? Solicite ao responsável um link de recuperação.
            Não há cadastro público.
          </p>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
