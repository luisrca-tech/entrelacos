import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="auth-shell">
      <div className="auth-frame">
        <aside className="auth-aside" aria-label="EntreLaços">
          <Link className="brand auth-brand" to="/">
            EntreLaços
          </Link>
          <div className="auth-aside-copy">
            <span className="auth-aside-mark" aria-hidden="true">
              E
            </span>
            <p>O seu dia, guardado com carinho.</p>
          </div>
          <span className="auth-aside-footer">Painel administrativo</span>
        </aside>
        <section className="auth-panel">{children}</section>
      </div>
    </main>
  );
}
