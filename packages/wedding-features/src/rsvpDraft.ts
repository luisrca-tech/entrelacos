export type RsvpStatus = "PENDING" | "CONFIRMED" | "DECLINED";

export type RsvpMemberSnapshot = {
  memberId: string;
  status: RsvpStatus;
  revision: number;
};

export type RsvpDraft = Record<
  string,
  {
    status: RsvpStatus;
    persistedStatus: RsvpStatus;
    revision: number;
  }
>;

export function createRsvpDraft(members: RsvpMemberSnapshot[]): RsvpDraft {
  return Object.fromEntries(
    members.map((member) => [
      member.memberId,
      {
        status: member.status,
        persistedStatus: member.status,
        revision: member.revision,
      },
    ]),
  );
}

export function setDraftStatus(
  draft: RsvpDraft,
  memberId: string,
  status: RsvpStatus,
): RsvpDraft {
  const member = draft[memberId];
  return member ? { ...draft, [memberId]: { ...member, status } } : draft;
}

export function confirmAllDraft(draft: RsvpDraft): RsvpDraft {
  return Object.fromEntries(
    Object.entries(draft).map(([memberId, member]) => [
      memberId,
      { ...member, status: "CONFIRMED" as const },
    ]),
  );
}

export function pendingRsvpUpdates(draft: RsvpDraft) {
  return Object.entries(draft)
    .filter(([, member]) => member.status !== member.persistedStatus)
    .map(([memberId, member]) => ({
      memberId,
      status: member.status,
      expectedRevision: member.revision,
    }));
}

export function reconcileRsvpDraft(
  draft: RsvpDraft,
  current: RsvpMemberSnapshot[],
): RsvpDraft {
  return Object.fromEntries(
    current.map((member) => [
      member.memberId,
      {
        status: draft[member.memberId]?.status ?? member.status,
        persistedStatus: member.status,
        revision: member.revision,
      },
    ]),
  );
}
