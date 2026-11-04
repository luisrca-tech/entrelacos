import { describe, expect, it } from "vitest";
import {
  asaasTasksKey,
  documentsTaskStatus,
  readAsaasTasks,
  writeAsaasTasks,
} from "./asaasTasks";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

describe("Asaas activation tasks", () => {
  it("scopes the marks to the site and holder", () => {
    expect(asaasTasksKey("site-a", "user-1")).toBe(
      "entrelacos:asaas-tasks:site-a:user-1",
    );
  });

  it("round-trips the couple's own marks", () => {
    const storage = memoryStorage();
    writeAsaasTasks(storage, "k", { password: true, phone: false });
    expect(readAsaasTasks(storage, "k")).toEqual({
      password: true,
      phone: false,
    });
  });

  it("falls back to unmarked tasks for missing, corrupt or blocked storage", () => {
    const empty = { password: false, phone: false };
    expect(readAsaasTasks(memoryStorage(), "k")).toEqual(empty);
    expect(readAsaasTasks(memoryStorage({ k: "{oops" }), "k")).toEqual(empty);
    expect(
      readAsaasTasks(memoryStorage({ k: '{"password":"yes"}' }), "k"),
    ).toEqual(empty);
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readAsaasTasks(blocked, "k")).toEqual(empty);
    expect(() =>
      writeAsaasTasks(blocked, "k", { password: true, phone: true }),
    ).not.toThrow();
    expect(readAsaasTasks(null, "k")).toEqual(empty);
  });

  it("derives the documents task from the Asaas review", () => {
    expect(documentsTaskStatus("APPROVED")).toBe("done");
    expect(documentsTaskStatus("AWAITING_APPROVAL")).toBe("review");
    expect(documentsTaskStatus("REJECTED")).toBe("attention");
    expect(documentsTaskStatus("PENDING")).toBe("waiting");
    expect(documentsTaskStatus(undefined)).toBe("waiting");
  });
});
