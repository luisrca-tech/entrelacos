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
import { adminStyles } from "../lib/adminStyles";
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
      <Card
        className="w-full max-w-[480px] mx-auto border-0 bg-transparent shadow-none [&_[data-slot=card-header]]:p-0 [&_[data-slot=card-content]]:p-0 [&_[data-slot=card-description]]:mt-4 [&_[data-slot=card-description]]:max-w-[44ch] [&_[data-slot=card-description]]:text-admin-muted [&_[data-slot=card-description]]:leading-[1.65]"
        aria-labelledby="login-title"
      >
        <CardHeader>
          <p className="m-0 mb-3.5 text-[0.7rem] font-bold uppercase tracking-[0.13em] leading-[1.3] text-admin-terracotta-deep">
            Acesso ao painel
          </p>
          <h1
            className="m-0 max-w-[780px] font-admin-display text-[clamp(2.4rem,5vw,4rem)] font-normal leading-[1.04] tracking-[-0.025em]"
            id="login-title"
          >
            Bem-vindo de volta.
          </h1>
          <CardDescription>
            Entre com o acesso recebido do responsável pelo seu casamento.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="my-[34px] mb-[22px] grid gap-[18px]"
            method="post"
            onSubmit={submit}
          >
            <label
              className="grid gap-2 text-[0.88rem] font-semibold text-admin-graphite"
              htmlFor="login-email"
            >
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
            <label
              className="grid gap-2 text-[0.88rem] font-semibold text-admin-graphite"
              htmlFor="login-password"
            >
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
            {error && (
              <p className={adminStyles.alert} role="alert">
                {error}
              </p>
            )}
            <Button
              className="w-fit justify-self-start"
              type="submit"
              data-login-ready={hydrated ? "true" : undefined}
              disabled={!hydrated || pending}
            >
              {pending ? "Entrando…" : "Entrar"}
            </Button>
          </form>
          <p className="text-[0.87rem] leading-[1.6] text-admin-muted">
            Esqueceu a senha? Solicite ao responsável um link de recuperação.
            Não há cadastro público.
          </p>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
