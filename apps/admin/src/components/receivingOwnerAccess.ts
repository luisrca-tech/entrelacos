import {
  type SiteAccess,
  siteAccessResponseSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { apiRequest } from "../lib/apiClient";
import { panelActorOwner } from "./panelActor";

export async function loadReceivingOwnerAccess(
  siteId: string,
  epoch: number | null,
  ports: {
    owner?: typeof panelActorOwner;
    request?: (path: string) => Promise<unknown>;
    now?: () => number;
  } = {},
): Promise<SiteAccess | null> {
  const id = siteIdSchema.parse(siteId),
    owner = ports.owner ?? panelActorOwner;
  const captured = owner.getSnapshot(),
    actor = captured.actor;
  const now = ports.now ?? Date.now;
  const current = () => {
    const time = now();
    return (
      epoch !== null &&
      captured.status === "verified" &&
      actor?.user.role === "OWNER" &&
      captured.sessionEpoch === epoch &&
      owner.getSnapshot() === captured &&
      Number.isSafeInteger(time) &&
      time >= 0 &&
      Date.parse(actor.session.expiresAt) > time
    );
  };
  if (!current()) return null;
  try {
    const response = siteAccessResponseSchema.parse(
      await (ports.request ?? apiRequest)(
        `/v1/sites/${encodeURIComponent(id)}/access`,
      ),
    );
    if (!current()) return null;
    const access = response.access;
    if (
      access.siteId !== id ||
      access.userId !== actor?.user.id ||
      access.membershipRole !== "OWNER" ||
      access.membershipId !== null ||
      !access.capabilities.readFinance ||
      access.capabilities.configureReceiving ||
      access.capabilities.requestWithdrawal
    )
      throw new Error("Receiving owner access unavailable");
    return access;
  } catch (cause) {
    if (!current()) return null;
    owner.reportFailure(cause, epoch);
    throw cause;
  }
}
