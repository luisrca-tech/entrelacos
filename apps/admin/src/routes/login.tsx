import { Button, Input, PasswordInput } from "@entrelacos/ui";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { AuthLayout } from "../components/AuthLayout";
import {
  createPanelAuthenticationActions,
  panelActorOwner,
} from "../components/panelActor";
import { adminStyles } from "../lib/adminStyles";
import { apiRequest, safePanelReturn } from "../lib/apiClient";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    email: typeof search.email === "string" ? search.email : "",
    next: safePanelReturn(search.next),
  }),
  component: LoginPage,
});

export function signInPanel(body: {
  email: FormDataEntryValue | null;
  password: FormDataEntryValue | null;
}) {
  return panelActorOwner.runAuthentication(() =>
    apiRequest("/v1/auth/sign-in/email", { method: "POST", body }),
  );
}
export function submitPanelSignIn(
  actions: ReturnType<typeof createPanelAuthenticationActions>,
  body: Parameters<typeof signInPanel>[0],
  onSuccess: () => void,
  onFailure: () => void,
) {
  return actions.run(() => signInPanel(body), onSuccess, onFailure);
}

function LoginPage() {
  const search = Route.useSearch();
  const [hydrated, setHydrated] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const authActions = useRef<ReturnType<
    typeof createPanelAuthenticationActions
  > | null>(null);

  useEffect(() => {
    const actions = createPanelAuthenticationActions();
    authActions.current = actions;
    setHydrated(true);
    return () => {
      actions.dispose();
      if (authActions.current === actions) authActions.current = null;
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const actions = authActions.current;
    if (!actions) return;
    setFailed(false);
    setPending(true);
    await submitPanelSignIn(
      actions,
      {
        email: form.get("email"),
        password: form.get("password"),
      },
      () => window.location.assign(search.next),
      () => {
        setFailed(true);
        setPending(false);
      },
    );
  }

  return (
    <AuthLayout>
      <section className="grid gap-[22px]" aria-labelledby="login-title">
        <header className="grid gap-3">
          <p className={adminStyles.authEyebrow}>Acesso ao painel</p>
          <h1 className={adminStyles.authHeading} id="login-title">
            Entre no seu painel.
          </h1>
          <p className="m-0 text-[15px] leading-relaxed text-admin-text-secondary">
            Use seu e-mail e sua senha para cuidar dos detalhes do casamento.
          </p>
        </header>
        {failed && (
          <p role="alert" className={adminStyles.authError}>
            Não foi possível entrar. Confira o e-mail e a senha ou solicite um
            novo acesso ao responsável.
          </p>
        )}
        <form className={adminStyles.authForm} method="post" onSubmit={submit}>
          <label className="grid gap-[7px]" htmlFor="login-email">
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
          <div className="grid gap-[7px]">
            <label htmlFor="login-password">Senha</label>
            <PasswordInput
              id="login-password"
              name="password"
              autoComplete="current-password"
              required
              maxLength={200}
            />
          </div>
          <Button
            className={adminStyles.authButton}
            type="submit"
            data-login-ready={hydrated ? "true" : undefined}
            disabled={!hydrated || pending}
          >
            {pending ? "Entrando…" : "Entrar"}
          </Button>
        </form>
        <p className="m-0 text-[13px] leading-relaxed text-admin-text-secondary">
          Primeiro acesso ou esqueceu a senha? Peça um link de acesso ao
          responsável pelo casamento.
        </p>
      </section>
    </AuthLayout>
  );
}
