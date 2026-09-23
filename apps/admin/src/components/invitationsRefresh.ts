const eventName = "entrelacos:invitations-changed";

type InvitationsChangedDetail = { siteId: string };

export function emitInvitationsChanged(target: EventTarget, siteId: string) {
  target.dispatchEvent(
    new CustomEvent<InvitationsChangedDetail>(eventName, {
      detail: { siteId },
    }),
  );
}

export function listenForInvitationsChanged(
  target: EventTarget,
  siteId: string,
  listener: () => void,
) {
  const handle = (event: Event) => {
    if (
      event instanceof CustomEvent &&
      (event.detail as InvitationsChangedDetail | undefined)?.siteId === siteId
    ) {
      listener();
    }
  };
  target.addEventListener(eventName, handle);
  return () => target.removeEventListener(eventName, handle);
}
