import type { MeResponse } from "@entrelacos/contracts";
import { apiRequest } from "../lib/apiClient";

let cachedPanelActor: MeResponse | null = null;
let panelActorRequest: Promise<MeResponse> | null = null;

export function getCachedPanelActor(): MeResponse | null {
  return cachedPanelActor;
}

export function loadPanelActor(): Promise<MeResponse> {
  if (cachedPanelActor) return Promise.resolve(cachedPanelActor);
  if (panelActorRequest) return panelActorRequest;

  const request = apiRequest<MeResponse>("/v1/me");
  const trackedRequest = request
    .then((value) => {
      cachedPanelActor = value;
      return value;
    })
    .finally(() => {
      if (panelActorRequest === trackedRequest) panelActorRequest = null;
    });
  panelActorRequest = trackedRequest;
  return trackedRequest;
}

export function resetPanelActorCache() {
  cachedPanelActor = null;
  panelActorRequest = null;
}
