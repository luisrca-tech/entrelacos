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
import { adminStyles } from "../lib/adminStyles";
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
      <Card className="w-full max-w-[480px] mx-auto border-0 bg-transparent shadow-none [&_[data-slot=card-header]]:p-0 [&_[data-slot=card-content]]:p-0 [&_[data-slot=card-description]]:mt-4 [&_[data-slot=card-description]]:max-w-[44ch] [&_[data-slot=card-description]]:text-admin-muted [&_[data-slot=card-description]]:leading-[1.65]">
        <CardHeader>
          <p className="m-0 mb-3.5 text-[0.7rem] font-bold uppercase tracking-[0.13em] leading-[1.3] text-admin-terracotta-deep">
            {purpose === "activation" ? "Primeiro acesso" : "Recuperar acesso"}
          </p>
          <h1 className="m-0 max-w-[780px] font-admin-display text-[clamp(2.4rem,5vw,4rem)] font-normal leading-[1.04] tracking-[-0.025em]">
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
              className="mt-6 inline-flex min-h-[42px] w-fit items-center justify-center rounded-lg border border-admin-graphite bg-admin-graphite px-[17px] py-2.5 text-[0.88rem] font-bold text-[#fffaf6] no-underline hover:bg-admin-ink"
              to="/login"
              search={{ email, next: "/" }}
            >
              Ir para o login
            </Link>
          ) : !ready ? (
            <p className="leading-[1.6]" role="status">
              Carregando…
            </p>
          ) : !hasValidAccessToken(token) ? (
            <p className={adminStyles.alert} role="alert">
              Link inválido. Solicite um novo link ao responsável.
            </p>
          ) : (
            <>
              <p className="m-0 mb-5 leading-[1.6] text-admin-muted">
                O link vale por 24 horas e pode ser usado uma vez.
              </p>
              <form className={adminStyles.authForm} onSubmit={submit}>
                <label
                  className="grid gap-2 text-[0.88rem] font-semibold text-admin-graphite"
                  htmlFor="access-password"
                >
                  Nova senha
                  <Input
                    id="access-password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    minLength={10}
                    maxLength={12}
                    required
                  />
                </label>
                <label
                  className="grid gap-2 text-[0.88rem] font-semibold text-admin-graphite"
                  htmlFor="access-confirmation"
                >
                  Confirmar senha
                  <Input
                    id="access-confirmation"
                    name="confirmation"
                    type="password"
                    autoComplete="new-password"
                    minLength={10}
                    maxLength={12}
                    required
                  />
                </label>
                <p className="text-[0.87rem] leading-[1.6] text-admin-muted">
                  Use de 10 a 12 caracteres.
                </p>
                {error && (
                  <p className={adminStyles.alert} role="alert">
                    {error}
                  </p>
                )}
                <Button
                  className="w-fit justify-self-start"
                  disabled={pending}
                  type="submit"
                >
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
