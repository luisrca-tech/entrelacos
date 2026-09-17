import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  Input,
} from "@entrelacos/ui";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { apiRequest } from "../lib/apiClient";
import { AuthLayout } from "./AuthLayout";
import { hasValidAccessToken, readAccessTokenFromHash } from "./accessToken";

export function AccessForm({
  purpose,
}: {
  purpose: "activation" | "recovery";
}) {
  const [token, setToken] = useState(() =>
    typeof window === "undefined"
      ? ""
      : readAccessTokenFromHash(window.location.hash),
  );
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setToken(
      (current) => current || readAccessTokenFromHash(window.location.hash),
    );
    setReady(true);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get("password") !== form.get("confirmation")) {
      setError("As senhas precisam ser iguais.");
      return;
    }
    setError("");
    setPending(true);
    try {
      const result = await apiRequest<{ email: string }>(
        `/v1/auth/${purpose}/consume`,
        { method: "POST", body: { token, password: form.get("password") } },
      );
      setEmail(result.email);
      setToken("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível definir a senha.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout>
      <Card className="auth-card">
        <CardHeader>
          <p className="eyebrow">
            {purpose === "activation" ? "Primeiro acesso" : "Recuperar acesso"}
          </p>
          <h1 className="auth-title">
            {email ? "Senha definida." : "Defina sua senha."}
          </h1>
          <CardDescription>
            {email
              ? "Agora entre com seu e-mail e a nova senha."
              : "Crie uma senha segura para acessar o painel."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {email ? (
            <Link
              className="primary-action"
              to="/login"
              search={{ email, next: "/" }}
            >
              Ir para o login
            </Link>
          ) : !ready ? (
            <p role="status">Carregando…</p>
          ) : !hasValidAccessToken(token) ? (
            <p role="alert">
              Link inválido. Solicite um novo link ao responsável.
            </p>
          ) : (
            <>
              <p className="lede">
                O link vale por 24 horas e pode ser usado uma vez.
              </p>
              <form className="data-form" onSubmit={submit}>
                <label htmlFor="access-password">
                  Nova senha
                  <Input
                    id="access-password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={200}
                    required
                  />
                </label>
                <label htmlFor="access-confirmation">
                  Confirmar senha
                  <Input
                    id="access-confirmation"
                    name="confirmation"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={200}
                    required
                  />
                </label>
                <p className="help-text">Use pelo menos 12 caracteres.</p>
                {error && <p role="alert">{error}</p>}
                <Button disabled={pending} type="submit">
                  {pending ? "Salvando…" : "Definir senha"}
                </Button>
              </form>
            </>
          )}
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
