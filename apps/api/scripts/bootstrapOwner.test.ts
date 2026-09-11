import { describe, expect, it, vi } from "vitest";
import { runBootstrapOwner } from "./bootstrapOwner";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@entrelacos/database", () => ({
  createDatabaseConnection: mocks.create,
  verifyDatabaseConnection: vi.fn(),
}));
describe("restricted owner bootstrap", () => {
  it("rejects production before any connection", async () => {
    await expect(
      runBootstrapOwner({
        ENTRELACOS_DATABASE_TARGET: "production",
        ENTRELACOS_OWNER_EMAIL: "owner@example.test",
        ENTRELACOS_OWNER_NAME: "Owner",
        ENTRELACOS_OWNER_PASSWORD: "fixture-password",
      }),
    ).rejects.toThrow();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("does not connect without complete private bootstrap configuration", async () => {
    await expect(
      runBootstrapOwner({ ENTRELACOS_DATABASE_TARGET: "test" }),
    ).rejects.toThrow();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
