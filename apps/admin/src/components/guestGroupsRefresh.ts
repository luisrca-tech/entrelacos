const eventName = "entrelacos:guest-groups-changed";

type GuestGroupsChangedDetail = {
  siteId: string;
};

export function emitGuestGroupsChanged(target: EventTarget, siteId: string) {
  target.dispatchEvent(
    new CustomEvent<GuestGroupsChangedDetail>(eventName, {
      detail: { siteId },
    }),
  );
}

export function listenForGuestGroupsChanged(
  target: EventTarget,
  siteId: string,
  listener: () => void,
) {
  const handle = (event: Event) => {
    if (
      event instanceof CustomEvent &&
      (event.detail as GuestGroupsChangedDetail | undefined)?.siteId === siteId
    ) {
      listener();
    }
  };
  target.addEventListener(eventName, handle);
  return () => target.removeEventListener(eventName, handle);
}
