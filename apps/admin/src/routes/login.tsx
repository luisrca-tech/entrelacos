import { Button } from "@entrelacos/ui";
import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/login")({
  component: LoginPlaceholderPage,
});

function LoginPlaceholderPage() {
  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="login-title">
        <Link className="back-link" to="/">
          ← Voltar para o scaffold
        </Link>
        <p className="eyebrow">Acesso ao painel</p>
        <h1 id="login-title">Login em preparação.</h1>
        <p className="lede">
          A autenticação Better Auth será conectada ao serviço de API em uma
          etapa posterior. Este formulário é somente uma referência visual e não
          processa credenciais.
        </p>

        <fieldset className="form-placeholder">
          <legend>Credenciais (indisponíveis no scaffold)</legend>
          <label>
            E-mail
            <input type="email" placeholder="nome@exemplo.com" disabled />
          </label>
          <label>
            Senha
            <input type="password" placeholder="••••••••" disabled />
          </label>
          <Button type="button" disabled>
            Entrar (indisponível no scaffold)
          </Button>
        </fieldset>
      </section>
    </main>
  );
}
