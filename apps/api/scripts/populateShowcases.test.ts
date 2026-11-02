import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
  verify: vi.fn(),
  storageClose: vi.fn(),
}));
vi.mock("@entrelacos/database", () => ({
  createDatabaseConnection: () => ({
    pool: { connect: fake.connect },
    close: fake.close,
  }),
  verifyDatabaseConnection: fake.verify,
}));
vi.mock("../src/giftMediaConfig", () => ({
  readGiftMediaConfig: () => ({ mode: "r2" }),
}));
vi.mock("../src/giftMediaStorage", () => ({
  createR2GiftMediaStorage: () => ({ close: fake.storageClose }),
}));

import { populateShowcases } from "./populateShowcases";

const env = {
  APP_ENV: "development",
  ENTRELACOS_DATABASE_TARGET: "development",
  ENTRELACOS_SHOWCASE_CONFIRM: "POPULATE development EntreLacos showcases",
};
beforeEach(() => {
  vi.clearAllMocks();
  fake.connect.mockResolvedValue({ query: fake.query, release: fake.release });
  fake.close.mockResolvedValue(undefined);
  fake.storageClose.mockResolvedValue(undefined);
  fake.verify.mockResolvedValue(undefined);
  fake.query.mockImplementation(async (sql: string) => ({
    rows: sql.startsWith("SELECT *,")
      ? [{ id: "demo-wedding", is_demo: false }]
      : [],
  }));
});
describe("showcase population operational boundaries", () => {
  it("refuses environment mismatch before opening a database", async () => {
    await expect(
      populateShowcases({ ...env, APP_ENV: "production" }),
    ).rejects.toThrow("target must match");
    expect(fake.connect).not.toHaveBeenCalled();
  });
  it("checks database identity before beginning writes", async () => {
    fake.verify.mockRejectedValueOnce(new Error("Identity mismatch"));
    await expect(populateShowcases(env)).rejects.toThrow("Identity mismatch");
    expect(fake.query).not.toHaveBeenCalled();
    expect(fake.release).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledOnce();
    expect(fake.storageClose).toHaveBeenCalledOnce();
  });
  it("rolls back genuine site refusal without inserting or changing data", async () => {
    await expect(populateShowcases(env)).rejects.toThrow("showcase identity");
    expect(
      fake.query.mock.calls.some(([sql]) =>
        /^INSERT|^UPDATE|^DELETE/.test(sql),
      ),
    ).toBe(false);
    expect(fake.query).toHaveBeenCalledWith("ROLLBACK");
    expect(fake.release).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledOnce();
  });
  it("disposes acquired resources if obtaining a database client fails", async () => {
    fake.connect.mockRejectedValueOnce(new Error("Connection unavailable"));
    await expect(populateShowcases(env)).rejects.toThrow(
      "Connection unavailable",
    );
    expect(fake.storageClose).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledOnce();
  });
});
