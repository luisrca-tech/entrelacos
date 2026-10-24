import type { MeResponse } from "@entrelacos/contracts";
import { Button, toast } from "@entrelacos/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { adminStyles, displayHeading } from "../lib/adminStyles";
import { apiRequest } from "../lib/apiClient";
import { AdminShell, ShellLoading } from "./AdminShell";
import { resolveSiteArea, type SiteArea } from "./adminNavigation";
import { OwnerSites } from "./OwnerSites";
import {
  createPanelAuthenticationActions,
  mountPanelSessionLifecycle,
  type PanelSessionSnapshot,
  panelActorOwner,
} from "./panelActor";
import {
  getPanelLanding,
  getSelectedSiteAccess,
  loadAssignedSiteName,
} from "./panelMemberships";
import { SiteWorkspace } from "./SiteWorkspace";

export function Panel({ siteId, area }: { siteId?: string; area?: SiteArea }) {
  const snapshot = useSyncExternalStore(
    panelActorOwner.subscribe,
    panelActorOwner.getSnapshot,
    panelActorOwner.getServerSnapshot,
  );
  const [siteName, setSiteName] = useState<string>();
  const authActions = useRef<ReturnType<
    typeof createPanelAuthenticationActions
  > | null>(null);
  useEffect(() => {
    const actions = createPanelAuthenticationActions();
    authActions.current = actions;
    const cleanup = mountPanelSessionLifecycle({ target: window, document });
    return () => {
      actions.dispose();
      if (authActions.current === actions) authActions.current = null;
      cleanup();
    };
  }, []);
  useEffect(() => {
    setSiteName(undefined);
    if (
      snapshot.status === "unauthenticated" &&
      panelActorOwner.getSnapshot() === snapshot
    ) {
      const next = window.location.pathname + window.location.search;
      window.location.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [snapshot]);

  async function logout() {
    const actions = authActions.current;
    if (!actions) return;
    await submitPanelSignOut(
      actions,
      () => window.location.replace("/login"),
      () => toast.error("Não foi possível sair. Tente novamente."),
    );
  }

  // Guard hidden-tab events synchronously; native disabled state can outlive the resume event.
  return (
    <fieldset
      className="contents"
      onSubmitCapture={(event) => {
        if (panelActorOwner.isSuspended()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onClickCapture={(event) => {
        if (panelActorOwner.isSuspended()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <PanelSessionView
        snapshot={snapshot}
        siteId={siteId}
        area={area}
        siteName={siteName}
        onSiteName={setSiteName}
        onVerify={() => {
          void panelActorOwner.load(true).catch(() => {});
        }}
        onLogout={() => void logout()}
      />
    </fieldset>
  );
}

export function signOutPanel() {
  return panelActorOwner.runAuthentication(() =>
    apiRequest("/v1/auth/sign-out", { method: "POST", body: {} }),
  );
}
export function submitPanelSignOut(
  actions: ReturnType<typeof createPanelAuthenticationActions>,
  onSuccess: () => void,
  onFailure: () => void,
) {
  return actions.run(signOutPanel, onSuccess, onFailure);
}

export function PanelSessionView({
  snapshot,
  siteId,
  area,
  siteName,
  onSiteName,
  onVerify,
  onLogout,
}: {
  snapshot: PanelSessionSnapshot;
  siteId?: string;
  area?: SiteArea;
  siteName?: string;
  onSiteName?: (name: string) => void;
  onVerify: () => void;
  onLogout: () => void;
}) {
  const { actor, sessionEpoch } = snapshot;
  if (snapshot.status !== "verified" || !actor || sessionEpoch === null) {
    const loading =
      snapshot.status === "unverified" ||
      snapshot.status === "loading" ||
      snapshot.status === "unauthenticated";
    return (
      <ShellLoading>
        {loading ? (
          <div role="status" aria-busy="true" aria-label="Carregando painel">
            <div className="h-8 w-48 animate-pulse rounded-lg bg-admin-line motion-reduce:animate-none" />
            <div className="mt-4 h-32 animate-pulse rounded-xl bg-admin-line motion-reduce:animate-none" />
          </div>
        ) : (
          <div className="grid gap-4">
            <p className={adminStyles.alert} role="alert">
              {snapshot.status === "denied"
                ? "Você não tem acesso ao painel."
                : "Não foi possível carregar o painel."}
            </p>
            <Button className="w-fit" onClick={onVerify}>
              Tentar novamente
            </Button>
          </div>
        )}
      </ShellLoading>
    );
  }

  const landing = getPanelLanding(actor);
  if (!siteId && landing.kind === "SITE")
    return <SiteAdminRedirect siteId={landing.siteId} />;
  if (!siteId && landing.kind === "EMPTY") {
    return (
      <ShellLoading>
        <p className={adminStyles.alert} role="alert">
          Nenhum casamento foi associado a esta conta.
        </p>
      </ShellLoading>
    );
  }

  const selectedAccess = siteId ? getSelectedSiteAccess(actor, siteId) : null;
  if (siteId && actor.user.role !== "OWNER" && !selectedAccess)
    return (
      <ShellLoading>
        <p className={adminStyles.alert} role="alert">
          Acesso negado ou casamento não encontrado.
        </p>
      </ShellLoading>
    );
  const selectedRole = selectedAccess?.membershipRole ?? actor.user.role;
  const resolvedArea = resolveSiteArea(selectedRole, area);
  if (siteId && area && resolvedArea !== area) {
    return <SiteAreaRedirect siteId={siteId} area={resolvedArea} />;
  }

  return (
    <AdminShell
      actor={actor}
      siteAccess={selectedAccess ?? undefined}
      siteId={siteId}
      siteName={siteName}
      area={siteId ? resolvedArea : undefined}
      onLogout={onLogout}
    >
      {siteId ? (
        <SiteWorkspace
          key={`${siteId}:${sessionEpoch}`}
          siteId={siteId}
          sessionEpoch={sessionEpoch}
          owner={actor.user.role === "OWNER"}
          access={selectedAccess}
          area={resolvedArea}
          onSiteName={onSiteName}
        />
      ) : landing.kind === "SELECT" ? (
        <AssignedSites key={sessionEpoch} actor={actor} />
      ) : (
        <OwnerSites key={sessionEpoch} />
      )}
    </AdminShell>
  );
}

function AssignedSiteName({ siteId }: { siteId: string }) {
  const [result, setResult] = useState<{ siteId: string; name: string } | null>(
    null,
  );
  useEffect(() => {
    let active = true;
    void loadAssignedSiteName(siteId)
      .then((name) => {
        if (active) setResult({ siteId, name });
      })
      .catch(() => {
        if (active) setResult({ siteId, name: "Casamento indisponível" });
      });
    return () => {
      active = false;
    };
  }, [siteId]);
  return (
    <span>
      {result?.siteId === siteId ? result.name : "Carregando casamento…"}
    </span>
  );
}

function AssignedSites({ actor }: { actor: MeResponse }) {
  return (
    <section className="grid gap-5">
      <h1 className={displayHeading}>Seus casamentos</h1>
      <p className="m-0 text-admin-muted">
        Escolha o casamento que deseja acompanhar.
      </p>
      <ul className="m-0 grid list-none gap-3 p-0">
        {(actor.memberships ?? [])
          .filter((entry) => entry.userId === actor.user.id)
          .map((entry) => (
            <li key={entry.siteId}>
              <Link
                className="flex min-h-14 items-center justify-between gap-4 rounded-xl border border-admin-line bg-admin-surface p-4 text-admin-graphite no-underline"
                to="/sites/$siteId/home"
                params={{ siteId: entry.siteId }}
              >
                <AssignedSiteName siteId={entry.siteId} />
                <span className="text-sm text-admin-muted">
                  {entry.membershipRole === "SITE_ASSISTANT"
                    ? "Assessor"
                    : "Administrador"}
                </span>
              </Link>
            </li>
          ))}
      </ul>
    </section>
  );
}

function SiteAdminRedirect({ siteId }: { siteId: string }) {
  useEffect(() => {
    window.location.replace(`/sites/${encodeURIComponent(siteId)}/home`);
  }, [siteId]);
  return <ShellLoading>Abrindo seu casamento…</ShellLoading>;
}

function SiteAreaRedirect({
  siteId,
  area,
}: {
  siteId: string;
  area: SiteArea;
}) {
  useEffect(() => {
    window.location.replace(`/sites/${encodeURIComponent(siteId)}/${area}`);
  }, [area, siteId]);
  return <ShellLoading>Redirecionando…</ShellLoading>;
}

export { lifecycleLabel } from "./OwnerSites";
