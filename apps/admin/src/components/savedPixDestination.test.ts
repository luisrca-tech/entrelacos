import { describe, expect, it, vi } from "vitest";
import { loadSavedPixDestination } from "./savedPixDestination";

const saved = {
  siteId: "site-1",
  mode: "sandbox",
  keyType: "CPF",
  maskedKey: "***.456.789-**",
  ownerName: "Ana Souza",
  maskedCpfCnpj: "***.456.789-**",
  bankName: "Banco do Destinatário S.A.",
  identity: "MATCH",
  withdrawalEnabled: false,
  destinationId: "destination-1",
  version: 2,
  state: "PENDING",
};

describe("saved Pix destination summary", () => {
  it("reads the selected site's saved destination", async () => {
    const request = vi.fn(async () => ({
      destination: saved,
      recentDestinations: [],
    }));
    await expect(loadSavedPixDestination("site-1", request)).resolves.toEqual({
      ownerName: "Ana Souza",
      keyType: "CPF",
      maskedKey: "***.456.789-**",
      bankName: "Banco do Destinatário S.A.",
    });
    expect(request).toHaveBeenCalledWith(
      "/v1/sites/site-1/receiving/pix-destination",
    );
  });
  it("returns null when nothing is saved or the answer is out of scope", async () => {
    await expect(
      loadSavedPixDestination("site-1", async () => ({
        destination: null,
        recentDestinations: [],
      })),
    ).resolves.toBeNull();
    await expect(
      loadSavedPixDestination("site-1", async () => ({
        destination: { ...saved, siteId: "site-2" },
        recentDestinations: [],
      })),
    ).resolves.toBeNull();
    await expect(
      loadSavedPixDestination("site-1", async () => ({ destination: "x" })),
    ).resolves.toBeNull();
    await expect(
      loadSavedPixDestination("site-1", async () => {
        throw new Error("offline");
      }),
    ).resolves.toBeNull();
  });
});
