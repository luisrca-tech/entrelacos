import {
  type MeResponse,
  meResponseSchema,
  type SiteTeamResponse,
  siteIdSchema,
} from "@entrelacos/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Input,
  toast,
} from "@entrelacos/ui";
import {
  type FormEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { apiRequest } from "../lib/apiClient";
import { panelActorOwner } from "./panelActor";
import { SiteTeamView } from "./SiteTeamView";
import { copyAdminAccessLink } from "./siteAdminMenu";
import {
  issueTeamInvitation,
  loadSiteTeam,
  teamInvitationUrl,
} from "./siteTeamClient";

type Revocation = { kind: "members" | "invitations"; id: string };

export type SiteTeamPorts = {
  owner?: typeof panelActorOwner;
  request?: (
    path: string,
    options?: { method?: string; body?: unknown },
  ) => Promise<unknown>;
  now?: () => number;
  isCurrent?: () => boolean;
  origin?: () => string;
  clipboard?: () => Pick<Clipboard, "writeText"> | null;
  success?: (message: string) => void;
  error?: (message: string) => void;
};
export type SiteTeamState = {
  authorized: boolean;
  team: SiteTeamResponse | null;
  error: string;
  pending: boolean;
  link: string;
  target: Revocation | null;
};
const emptyTeamState: SiteTeamState = {
  authorized: false,
  team: null,
  error: "",
  pending: false,
  link: "",
  target: null,
};
const defaultTeamPorts: SiteTeamPorts = {};

export function createSiteTeamController(
  initialScope: { siteId: string; canManage: boolean },
  onChange: (state: SiteTeamState) => void,
  ports: SiteTeamPorts = {},
) {
  const scope = { ...initialScope };
  const owner = ports.owner ?? panelActorOwner;
  const request = ports.request ?? apiRequest;
  const snapshot = owner.getSnapshot();
  const parsed = meResponseSchema.safeParse(snapshot.actor);
  const actor: MeResponse | null = parsed.success ? parsed.data : null;
  const selected =
    actor?.memberships?.filter(
      (access) =>
        access.siteId === scope.siteId && access.userId === actor.user.id,
    ) ?? [];
  const authorized = Boolean(
    scope.canManage &&
      siteIdSchema.safeParse(scope.siteId).success &&
      snapshot.status === "verified" &&
      snapshot.sessionEpoch !== null &&
      actor &&
      !actor.memberships?.some((access) => access.userId !== actor.user.id) &&
      (actor.user.role === "OWNER" ||
        (actor.user.role === "SITE_ADMIN" &&
          selected.length === 1 &&
          selected[0].membershipRole === "SITE_ADMIN" &&
          selected[0].membershipId &&
          selected[0].capabilities.manageTeam)),
  );
  let active = true;
  let busy = false;
  let revision = 0;
  let clock = -1;
  let state: SiteTeamState = { ...emptyTeamState, authorized };
  function current(attempt = revision) {
    try {
      if (
        !active ||
        !authorized ||
        (ports.owner ?? panelActorOwner) !== owner ||
        attempt !== revision ||
        ports.isCurrent?.() === false ||
        owner.getSnapshot() !== snapshot
      )
        return false;
      const time = (ports.now ?? Date.now)();
      if (
        !Number.isSafeInteger(time) ||
        time < 0 ||
        time < clock ||
        !actor ||
        Date.parse(actor.session.expiresAt) <= time
      )
        return false;
      clock = time;
      const observed = owner.getSnapshot();
      const liveScope = ports.isCurrent?.() !== false;
      const liveOwner = (ports.owner ?? panelActorOwner) === owner;
      return (
        active &&
        attempt === revision &&
        liveScope &&
        liveOwner &&
        observed === snapshot
      );
    } catch {
      return false;
    }
  }
  function notify() {
    try {
      onChange(state);
    } catch {
      active = false;
      revision++;
      busy = false;
      state = { ...emptyTeamState };
    }
  }
  function cancel() {
    if (!active) return;
    active = false;
    revision++;
    busy = false;
    state = { ...emptyTeamState };
    if (ports.isCurrent?.() !== false) notify();
  }
  const unsubscribe = owner.subscribe(cancel);
  function publish(next: SiteTeamState, attempt = revision) {
    if (!current(attempt)) return false;
    state = next;
    notify();
    return current(attempt);
  }
  function reserve() {
    if (busy || !current()) return null;
    busy = true;
    const attempt = ++revision;
    return publish({ ...state, pending: true, error: "" }, attempt)
      ? attempt
      : null;
  }
  function guarded(attempt: number) {
    return async (
      path: string,
      options?: { method?: string; body?: unknown },
    ) => {
      if (!current(attempt)) throw new Error("Team ownership changed");
      const result = await request(path, options);
      if (!current(attempt)) throw new Error("Team ownership changed");
      return result;
    };
  }
  async function verify(attempt: number) {
    const fresh = meResponseSchema.parse(await guarded(attempt)("/v1/me"));
    if (!current(attempt)) throw new Error("Team ownership changed");
    if (JSON.stringify(fresh) !== JSON.stringify(actor)) {
      cancel();
      throw new Error("Team identity changed");
    }
  }
  function failure(cause: unknown, message: string, attempt: number) {
    if (!current(attempt)) return;
    const report = owner.reportFailure;
    if (!current(attempt)) return;
    report.call(owner, cause, snapshot.sessionEpoch);
    if (!publish({ ...state, error: message }, attempt)) return;
    feedback("error", message, attempt);
  }
  function feedback(
    kind: "success" | "error",
    message: string,
    attempt: number,
  ) {
    const callback =
      kind === "success"
        ? (ports.success ?? toast.success)
        : (ports.error ?? toast.error);
    if (current(attempt)) callback(message);
  }
  function finish(attempt: number) {
    if (!current(attempt)) return;
    busy = false;
    publish({ ...state, pending: false }, attempt);
  }
  async function refresh() {
    const attempt = reserve();
    if (attempt === null) return;
    try {
      const team = await loadSiteTeam(scope.siteId, guarded(attempt));
      publish({ ...state, team }, attempt);
    } catch (cause) {
      failure(
        cause,
        "Não foi possível carregar a equipe. Tente novamente.",
        attempt,
      );
    } finally {
      finish(attempt);
    }
  }
  async function invite(
    input: unknown,
    onCreated?: (isCurrent: () => boolean) => void,
  ) {
    const attempt = reserve();
    if (attempt === null) return;
    try {
      if (!publish({ ...state, link: "" }, attempt)) return;
      await verify(attempt);
      const result = await issueTeamInvitation(
        scope.siteId,
        input,
        guarded(attempt),
      );
      if (!current(attempt)) return;
      const origin = (ports.origin ?? (() => window.location.origin))();
      if (!current(attempt)) return;
      const link = teamInvitationUrl(origin, result.token);
      if (!current(attempt)) return;
      const clipboard = (
        ports.clipboard ?? (() => navigator.clipboard ?? null)
      )();
      if (!current(attempt)) return;
      const copied = clipboard
        ? await copyAdminAccessLink(link, {
            async writeText(value) {
              if (!current(attempt)) throw new Error("Team ownership changed");
              const write = clipboard.writeText;
              if (!current(attempt)) throw new Error("Team ownership changed");
              await write.call(clipboard, value);
              if (!current(attempt)) throw new Error("Team ownership changed");
            },
          })
        : false;
      if (!current(attempt)) return;
      const team = await loadSiteTeam(scope.siteId, guarded(attempt));
      if (!publish({ ...state, team, link }, attempt)) return;
      onCreated?.(() => current(attempt));
      if (!current(attempt)) return;
      feedback(
        "success",
        copied
          ? "Link de convite copiado. Compartilhe com o assessor."
          : "Convite criado. Copie o link abaixo e compartilhe com o assessor.",
        attempt,
      );
    } catch (cause) {
      failure(
        cause,
        "Não foi possível criar o convite. Tente novamente.",
        attempt,
      );
    } finally {
      finish(attempt);
    }
  }
  async function revoke() {
    const target = state.target;
    if (!target) return;
    const attempt = reserve();
    if (attempt === null) return;
    try {
      await verify(attempt);
      await guarded(attempt)(
        `/v1/sites/${encodeURIComponent(scope.siteId)}/team/${target.kind}/${encodeURIComponent(target.id)}/revoke`,
        { method: "POST", body: {} },
      );
      if (!current(attempt)) return;
      const team = await loadSiteTeam(scope.siteId, guarded(attempt));
      if (!publish({ ...state, team, target: null, link: "" }, attempt)) return;
      feedback(
        "success",
        target.kind === "members"
          ? "Acesso de assessor revogado neste casamento."
          : "Convite de assessor revogado.",
        attempt,
      );
    } catch (cause) {
      failure(
        cause,
        "Não foi possível revogar o acesso. Tente novamente.",
        attempt,
      );
    } finally {
      finish(attempt);
    }
  }
  return {
    getState: () => state,
    start: refresh,
    refresh,
    invite,
    revoke,
    selectTarget(target: Revocation | null) {
      if (busy || !current()) return;
      if (
        target &&
        !(target.kind === "members"
          ? state.team?.members.some(
              (entry) => entry.userId === target.id && entry.revokedAt === null,
            )
          : state.team?.invitations.some(
              (entry) =>
                entry.id === target.id &&
                entry.revokedAt === null &&
                entry.consumedAt === null,
            ))
      )
        return;
      publish({ ...state, target });
    },
    hideLink() {
      if (current()) publish({ ...state, link: "" });
    },
    dispose() {
      active = false;
      revision++;
      busy = false;
      state = { ...emptyTeamState };
      unsubscribe();
    },
  };
}

export function SiteTeamSection({
  siteId,
  canManage,
  ports = defaultTeamPorts,
}: {
  siteId: string;
  canManage: boolean;
  ports?: SiteTeamPorts;
}) {
  const owner = ports.owner ?? panelActorOwner;
  const snapshot = useSyncExternalStore(
    owner.subscribe,
    owner.getSnapshot,
    owner.getServerSnapshot,
  );
  const scope = useRef({ siteId, canManage, owner, ports });
  scope.current = { siteId, canManage, owner, ports };
  return (
    <SiteTeamRuntime
      key={`${siteId}:${canManage}:${snapshot.status}:${snapshot.sessionEpoch}`}
      siteId={siteId}
      canManage={canManage}
      ports={ports}
      scope={scope}
    />
  );
}

function SiteTeamRuntime({
  siteId,
  canManage,
  ports,
  scope,
}: {
  siteId: string;
  canManage: boolean;
  ports: SiteTeamPorts;
  scope: {
    current: {
      siteId: string;
      canManage: boolean;
      owner: typeof panelActorOwner;
      ports: SiteTeamPorts;
    };
  };
}) {
  const owner = ports.owner ?? panelActorOwner;
  const holder = useRef<ReturnType<typeof createSiteTeamController> | null>(
    null,
  );
  const binding = useRef<{
    ports: SiteTeamPorts;
    owner: typeof panelActorOwner;
  } | null>(null);
  const [state, setState] = useState<SiteTeamState>(emptyTeamState);
  const [inviteOpen, setInviteOpen] = useState(false);
  useEffect(() => {
    const controller = createSiteTeamController(
      { siteId, canManage },
      (next) => {
        if (holder.current === controller) setState(next);
      },
      {
        ...ports,
        isCurrent: () =>
          holder.current === controller &&
          scope.current.siteId === siteId &&
          scope.current.canManage === canManage &&
          scope.current.owner === owner &&
          scope.current.ports === ports &&
          ports.isCurrent?.() !== false,
      },
    );
    holder.current = controller;
    binding.current = { ports, owner };
    setState(controller.getState());
    void controller.start();
    return () => {
      if (holder.current === controller) holder.current = null;
      controller.dispose();
    };
  }, [siteId, canManage, ports, scope, owner]);
  const { team, error, pending, link, target, authorized } =
    binding.current?.ports === ports && binding.current.owner === owner
      ? state
      : emptyTeamState;
  const controller = holder.current;
  function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      holder.current !== controller ||
      binding.current?.ports !== ports ||
      binding.current.owner !== owner
    )
      return;
    const form = event.currentTarget;
    const data = new FormData(form);
    void controller?.invite(
      {
        name: String(data.get("name") ?? ""),
        email: String(data.get("email") ?? ""),
      },
      (isCurrent) => {
        const reset = form.reset;
        if (isCurrent()) reset.call(form);
        if (isCurrent()) setInviteOpen(false);
      },
    );
  }

  return (
    <div className="grid min-w-0 gap-5">
      {authorized && link && (
        <section className="grid min-w-0 gap-3 rounded-xl border border-admin-line bg-admin-surface p-5">
          <label htmlFor="team-invite-link" className="text-sm font-semibold">
            Link de convite do assessor
          </label>
          <Input
            id="team-invite-link"
            value={link}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
          />
          <p className="m-0 text-sm text-admin-muted">
            Compartilhe somente com a pessoa convidada. O link vale por 24 horas
            e pode ser usado uma vez.
          </p>
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => controller?.hideLink()}
            >
              Ocultar link
            </Button>
          </div>
        </section>
      )}
      <SiteTeamView
        team={team}
        canManage={authorized}
        pending={pending}
        error={error}
        inviteOpen={inviteOpen}
        onInviteOpenChange={setInviteOpen}
        onInvite={invite}
        onRetry={() => void controller?.refresh()}
        onRevokeMember={(id) =>
          controller?.selectTarget({ kind: "members", id })
        }
        onRevokeInvitation={(id) =>
          controller?.selectTarget({ kind: "invitations", id })
        }
      />
      <AlertDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !pending) controller?.selectTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {target?.kind === "members"
                ? "Revogar acesso deste assessor?"
                : "Revogar este convite?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {target?.kind === "members"
                ? "O assessor perderá acesso a este casamento. Os outros casamentos e a conta dele serão preservados."
                : "Este link não poderá mais ser usado para entrar na equipe."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(event) => {
                event.preventDefault();
                void controller?.revoke();
              }}
            >
              Revogar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
