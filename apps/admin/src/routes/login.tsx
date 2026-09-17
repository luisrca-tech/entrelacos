import { createFileRoute, Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
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
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="login-title">
        <Link className="brand" to="/">
          EntreLaços
        </Link>
        <p className="eyebrow">Acesso ao painel</p>
        <h1 id="login-title">Bem-vindo de volta.</h1>
        <p className="lede">
          Entre com o acesso recebido do responsável pelo seu casamento.
        </p>
        <form className="data-form" method="post" onSubmit={submit}>
          <label>
            E-mail
            <input
              name="email"
              type="email"
              autoComplete="username"
              defaultValue={search.email}
              required
              maxLength={320}
            />
          </label>
          <label>
            Senha
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={200}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <button
            type="submit"
            data-login-ready={hydrated ? "true" : undefined}
            disabled={!hydrated || pending}
          >
            {pending ? "Entrando…" : "Entrar"}
          </button>
        </form>
        <p className="help-text">
          Esqueceu a senha? Solicite ao responsável um link de recuperação. Não
          há cadastro público.
        </p>
      </section>
    </main>
  );
}
