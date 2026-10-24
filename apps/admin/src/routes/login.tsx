import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  Input,
  PasswordInput,
  toast,
} from "@entrelacos/ui";
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
    setPending(true);
    await submitPanelSignIn(
      actions,
      {
        email: form.get("email"),
        password: form.get("password"),
      },
      () => window.location.assign(search.next),
      () => {
        toast.error(
          "Não foi possível entrar. Confira o e-mail e a senha ou solicite um novo acesso ao responsável.",
        );
        setPending(false);
      },
    );
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
            Entre no seu painel.
          </h1>
          <CardDescription>
            Use seu e-mail e sua senha para cuidar dos detalhes do casamento.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className={adminStyles.authForm}
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
            <div className="grid gap-2 text-[0.88rem] font-semibold text-admin-graphite">
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
              className="w-fit justify-self-start"
              type="submit"
              data-login-ready={hydrated ? "true" : undefined}
              disabled={!hydrated || pending}
            >
              {pending ? "Entrando…" : "Entrar"}
            </Button>
          </form>
          <p className="text-[0.87rem] leading-[1.6] text-admin-muted">
            Primeiro acesso ou esqueceu a senha? Peça um link de acesso ao
            responsável pelo casamento.
          </p>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
