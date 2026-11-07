import { PasswordInput, toast } from "@entrelacos/ui";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { adminStyles } from "../lib/adminStyles";
import { apiRequest } from "../lib/apiClient";
import { AdminButton } from "./AdminButton";
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
      toast.error("As senhas precisam ser iguais.");
      return;
    }
    setPending(true);
    try {
      const result = await apiRequest<{ email: string }>(
        `/v1/auth/${purpose}/consume`,
        { method: "POST", body: { token, password: form.get("password") } },
      );
      setEmail(result.email);
      setToken("");
    } catch (cause) {
      toast.error(
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
      <section className="grid gap-5" aria-labelledby="access-title">
        <header className="grid gap-3">
          <p className={adminStyles.authEyebrow}>
            {purpose === "activation" ? "Primeiro acesso" : "Recuperar acesso"}
          </p>
          <h1 className={adminStyles.authHeading} id="access-title">
            {email ? "Sua senha está pronta." : "Defina sua senha."}
          </h1>
          <p className="m-0 text-[15px] leading-relaxed text-admin-text-secondary">
            {email
              ? "Agora entre com seu e-mail e a nova senha."
              : purpose === "activation"
                ? "Escolha uma senha para começar a organizar o casamento."
                : "Escolha uma nova senha para voltar ao painel."}
          </p>
        </header>
        {email ? (
          <Link
            className={`${adminStyles.authButton} inline-flex items-center justify-center text-sm no-underline`}
            to="/login"
            search={{ email, next: "/" }}
          >
            Entrar no painel
          </Link>
        ) : !ready ? (
          <p className="leading-[1.6]" role="status">
            Carregando…
          </p>
        ) : !hasValidAccessToken(token) ? (
          <p className={adminStyles.authError} role="alert">
            Link inválido. Solicite um novo link ao responsável.
          </p>
        ) : (
          <>
            <p className="m-0 rounded-[10px] border border-admin-border bg-admin-canvas p-3 text-[13px] leading-relaxed text-admin-text-secondary">
              Este link é pessoal, vale por 24 horas e pode ser usado uma vez.
            </p>
            <form className={adminStyles.authForm} onSubmit={submit}>
              <div className="grid gap-2 text-[0.88rem] font-semibold text-admin-text">
                <label htmlFor="access-password">Nova senha</label>
                <PasswordInput
                  id="access-password"
                  name="password"
                  autoComplete="new-password"
                  minLength={6}
                  maxLength={10}
                  required
                />
              </div>
              <div className="grid gap-2 text-[0.88rem] font-semibold text-admin-text">
                <label htmlFor="access-confirmation">Confirmar senha</label>
                <PasswordInput
                  id="access-confirmation"
                  name="confirmation"
                  autoComplete="new-password"
                  minLength={6}
                  maxLength={10}
                  required
                />
              </div>
              <p className="text-[0.87rem] leading-[1.6] text-admin-text-secondary">
                Use de 6 a 10 caracteres.
              </p>
              <AdminButton
                tone="primary"
                className={adminStyles.authButton}
                disabled={pending}
                type="submit"
              >
                {pending ? "Salvando…" : "Definir senha"}
              </AdminButton>
            </form>
          </>
        )}
      </section>
    </AuthLayout>
  );
}
