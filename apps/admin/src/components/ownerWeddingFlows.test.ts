import { expect, it, vi } from "vitest";
import {
  validatePublicAddress,
  validateTrustedOrigins,
} from "./ownerSiteAddresses";
import {
  createWedding,
  type WeddingCheckpoint,
  weddingSlug,
} from "./weddingCreation";

it("retries only the link step after the site and administrator have been created", async () => {
  const draft = {
    site: {
      displayName: "Ana & João",
      coupleNames: ["Ana", "João"],
      eventDate: "2027-09-18",
      repositorySlug: "ana-joao",
      provisioningKey: "unique-key",
    },
    admin: { name: "Ana", email: "ana@example.test" },
    issueLink: true,
  };
  const request = vi
    .fn()
    .mockResolvedValueOnce({ site: { id: "wedding-a" } })
    .mockResolvedValueOnce({ userId: "person-a" })
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({
      token: "a".repeat(43),
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
  let checkpoint: WeddingCheckpoint = {};
  const save = (value: WeddingCheckpoint) => {
    checkpoint = value;
  };
  await expect(
    createWedding(draft, checkpoint, save, () => true, request),
  ).rejects.toThrow("offline");
  expect(checkpoint).toMatchObject({
    site: { id: "wedding-a" },
    userId: "person-a",
  });
  expect(
    await createWedding(draft, checkpoint, save, () => true, request),
  ).toMatchObject({
    site: { id: "wedding-a" },
    access: { token: "a".repeat(43) },
  });
  expect(request.mock.calls.map(([path]) => path)).toEqual([
    "/v1/owner/sites",
    "/v1/owner/sites/wedding-a/admins",
    "/v1/owner/admins/person-a/access",
    "/v1/owner/admins/person-a/access",
  ]);
});

it("suggests a normalized repository slug within the creation contract", () => {
  expect(weddingSlug("  João de Sá  ", "Ágata N.")).toBe(
    "joao-de-sa-e-agata-n",
  );
  expect(weddingSlug("A".repeat(120), "")).toHaveLength(64);
  expect(weddingSlug("", "")).toBe("");
});

it("validates each address independently and reports invalid origins in Portuguese", () => {
  expect(validatePublicAddress(" https://casamento.example/ ")).toEqual({
    value: { publicUrl: "https://casamento.example/" },
  });
  expect(
    validatePublicAddress("https://casamento.example/pagina"),
  ).toHaveProperty("error", expect.stringContaining("endereço público"));
  expect(
    validateTrustedOrigins(
      "https://casamento.example\n\nhttps://outro.example",
    ),
  ).toEqual({
    value: {
      trustedOrigins: ["https://casamento.example", "https://outro.example"],
    },
  });
  expect(validateTrustedOrigins("https://casamento.example/")).toHaveProperty(
    "error",
    expect.stringContaining("origem"),
  );
  expect(
    validateTrustedOrigins(
      "https://casamento.example\nhttps://casamento.example",
    ),
  ).toHaveProperty("error", expect.stringContaining("repetidos"));
});
