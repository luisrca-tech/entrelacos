import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: AdminScaffoldPage,
});

function AdminScaffoldPage() {
  return (
    <main className="page-shell">
      <header className="topbar">
        <Link className="brand" to="/">
          EntreLaços
        </Link>
        <span className="status-pill">Scaffold</span>
      </header>

      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">Painel central</p>
        <h1 id="page-title">A base do painel administrativo está pronta.</h1>
        <p className="lede">
          Esta é uma estrutura navegável para orientar as próximas entregas.
          Ainda não há login, permissões, dados ou integração com a API.
        </p>
        <Link className="primary-action" to="/login">
          Ver placeholder de login
        </Link>
      </section>

      <section className="area-grid" aria-labelledby="areas-title">
        <div className="section-heading">
          <p className="eyebrow">Limites planejados</p>
          <h2 id="areas-title">Duas áreas, uma entrada central</h2>
        </div>

        <article className="area-card">
          <p className="card-label">OWNER</p>
          <h3>Gestão global</h3>
          <p>
            Sites, usuários, status, domínios, datas e aprovação manual de cada
            casamento.
          </p>
        </article>

        <article className="area-card">
          <p className="card-label">OPERATIONAL</p>
          <h3>Operação por site</h3>
          <p>
            Grupos, RSVP, mensagens, prazos e consulta de status do casamento
            autorizado.
          </p>
        </article>
      </section>

      <footer className="page-footer">
        <span>Próxima etapa: contratos de autenticação e API.</span>
        <span>EntreLaços · 2026</span>
      </footer>
    </main>
  );
}
