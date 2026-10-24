import { afterEach, describe, expect, it, vi } from "vitest";
import { logWithdrawalFailure } from "./withdrawalDiagnostics";
import { readWithdrawalConsentRecord } from "./withdrawalReservations";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function diagnosticError(stack: unknown) {
  const error = new Error("private-message-token-password-sentinel");
  Object.defineProperty(error, "stack", { value: stack });
  return error;
}

describe("private-free development withdrawal diagnostics", () => {
  it.each(["test", "production", undefined])(
    "does not log in application environment %s",
    (environment) => {
      vi.stubEnv("APP_ENV", environment);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      logWithdrawalFailure(
        diagnosticError(
          "Error: private-message\n    at guard (/workspace/apps/api/src/withdrawalReservations.ts:637:25)",
        ),
      );
      expect(log).not.toHaveBeenCalled();
    },
  );

  it("logs only the fixed event and allowed API source coordinates", () => {
    vi.stubEnv("APP_ENV", "development");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = diagnosticError(
      [
        "private-message-token-password-sentinel /workspace/apps/api/src/withdrawalReservations.ts:1:2",
        "    at foreign (/workspace/apps/admin/src/withdrawalReservations.ts:11:12)",
        "    at secret (/workspace/apps/api/src/unapproved.ts:13:14)",
        "    at guard (/private/password-sentinel/apps/api/src/withdrawalReservations.ts:637:25)",
        "    at /workspace/apps/api/src/withdrawalReservationRepository.ts:644:5",
      ].join("\n"),
    );
    Object.assign(error, { name: "private-name", cause: "private-cause" });
    logWithdrawalFailure(error);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      event: "withdrawal_failure",
      frames: [
        { file: "withdrawalReservations.ts", line: 637, column: 25 },
        { file: "withdrawalReservationRepository.ts", line: 644, column: 5 },
      ],
    });
    expect(log.mock.calls[0][0]).not.toMatch(
      /private|password|sentinel|cause|message|workspace/,
    );
  });

  it("limits a diagnostic to four source frames", () => {
    vi.stubEnv("APP_ENV", "development");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    logWithdrawalFailure(
      diagnosticError(
        [
          "Error: private-message",
          ...Array.from(
            { length: 6 },
            (_, index) =>
              `    at guard (/workspace/apps/api/src/withdrawalReservations.ts:${index + 1}:2)`,
          ),
        ].join("\n"),
      ),
    );
    expect(JSON.parse(log.mock.calls[0][0]).frames).toEqual(
      [1, 2, 3, 4].map((line) => ({
        file: "withdrawalReservations.ts",
        line,
        column: 2,
      })),
    );
  });

  it.each([undefined, {}, "malformed", "x".repeat(32769)])(
    "does not log an invalid stack %#",
    (stack) => {
      vi.stubEnv("APP_ENV", "development");
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      logWithdrawalFailure(diagnosticError(stack));
      expect(log).not.toHaveBeenCalled();
    },
  );

  it("does not let a throwing stack getter or logger change error behavior", () => {
    vi.stubEnv("APP_ENV", "development");
    const error = new Error("private-message");
    Object.defineProperty(error, "stack", {
      get() {
        throw new Error("private-getter");
      },
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("private-logger");
    });
    expect(() => logWithdrawalFailure(error)).not.toThrow();
    expect(() =>
      logWithdrawalFailure(
        diagnosticError(
          "Error: private-message\n    at guard (/workspace/apps/api/src/withdrawalReservations.ts:637:25)",
        ),
      ),
    ).not.toThrow();
    expect(log).toHaveBeenCalledOnce();
  });

  it("captures a real guard origin without changing its sanitized public error", () => {
    vi.stubEnv("APP_ENV", "development");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      readWithdrawalConsentRecord({ password: "private-password-sentinel" }),
    ).toThrowError(
      expect.objectContaining({
        status: 503,
        code: "WITHDRAWAL_UNAVAILABLE",
        message: "Withdrawal reservation is unavailable",
      }),
    );
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("sentinel");
    expect(JSON.parse(log.mock.calls[0][0]).frames).toContainEqual(
      expect.objectContaining({ file: "withdrawalReservations.ts" }),
    );
  });
});

describe("allowlisted development custody database classification", () => {
  function wrapper(cause: unknown) {
    const error = diagnosticError(
      "Error: private-message\n    at record (/workspace/apps/api/src/asaasWithdrawalCustody.ts:173:9)",
    );
    Object.defineProperty(error, "cause", { value: cause });
    return error;
  }
  function logged(error: unknown) {
    vi.stubEnv("APP_ENV", "development");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    logWithdrawalFailure(error);
    return {
      log,
      payload: log.mock.calls.length
        ? JSON.parse(String(log.mock.calls[0][0]))
        : undefined,
    };
  }
  it.each(["23514", "23503", "23505", "25006", "42501"])(
    "classifies allowlisted SQLSTATE %s through an own-data cause",
    (code) => {
      const { log, payload } = logged(
        wrapper({
          code,
          constraint: "withdrawal_observation_time_check",
          message: "private-password-query-sentinel",
          query: "private-query",
          parameters: ["private-token"],
        }),
      );
      expect(payload).toEqual({
        event: "withdrawal_failure",
        frames: [{ file: "asaasWithdrawalCustody.ts", line: 173, column: 9 }],
        databaseFailure: {
          code,
          constraint: "withdrawal_observation_time_check",
        },
      });
      expect(JSON.stringify(log.mock.calls)).not.toMatch(
        /private|password|query|sentinel|token|parameters|cause|message/,
      );
    },
  );
  it.each([
    "withdrawal_provider_observation_pkey",
    "withdrawal_observation_operation_fk",
    "withdrawal_observation_hash_check",
    "withdrawal_observation_payload_check",
    "withdrawal_observation_time_check",
    "withdrawal_observation_provider_check",
  ])("allows only fixed custody constraint %s", (constraint) => {
    const { payload } = logged(wrapper({ code: "23514", constraint }));
    expect(payload.databaseFailure).toEqual({ code: "23514", constraint });
  });
  it("continues past an unknown wrapper code to the bounded underlying cause", () => {
    const error = wrapper({
      code: "PRIVATE_WRAPPER_SENTINEL",
      cause: {
        code: "23503",
        constraint: "withdrawal_observation_operation_fk",
      },
    });
    const { payload } = logged(error);
    expect(payload.databaseFailure).toEqual({
      code: "23503",
      constraint: "withdrawal_observation_operation_fk",
    });
  });
  it.each(["54000", "23514-private-sentinel", "PRIVATE_SENTINEL", undefined])(
    "does not classify unapproved code %s",
    (code) => {
      const { payload } = logged(
        wrapper({ code, constraint: "withdrawal_observation_time_check" }),
      );
      expect(payload).not.toHaveProperty("databaseFailure");
      expect(JSON.stringify(payload)).not.toMatch(
        /PRIVATE|private|54000|constraint/,
      );
    },
  );
  it("excludes unknown constraint names even when the SQLSTATE is allowed", () => {
    const { payload } = logged(
      wrapper({
        code: "23514",
        constraint: "private_unknown_constraint_sentinel",
      }),
    );
    expect(payload.databaseFailure).toEqual({ code: "23514" });
    expect(JSON.stringify(payload)).not.toMatch(/private|unknown|sentinel/);
  });
  it("does not evaluate code, constraint or cause accessors", () => {
    const getters = {
      code: vi.fn(() => "23514"),
      constraint: vi.fn(() => "withdrawal_observation_time_check"),
      cause: vi.fn(() => ({ code: "23503" })),
    };
    const cause = Object.defineProperties(
      {},
      {
        code: { get: getters.code },
        constraint: { get: getters.constraint },
        cause: { get: getters.cause },
      },
    );
    const { payload } = logged(wrapper(cause));
    expect(payload).not.toHaveProperty("databaseFailure");
    expect(getters.code).not.toHaveBeenCalled();
    expect(getters.constraint).not.toHaveBeenCalled();
    expect(getters.cause).not.toHaveBeenCalled();
  });
  it("does not evaluate a constraint accessor while retaining an allowed code", () => {
    const getter = vi.fn(() => "private_constraint_sentinel");
    const { payload } = logged(
      wrapper(
        Object.defineProperty({ code: "23514" }, "constraint", { get: getter }),
      ),
    );
    expect(payload.databaseFailure).toEqual({ code: "23514" });
    expect(getter).not.toHaveBeenCalled();
  });
  it("does not inspect proxies or evaluate their traps", () => {
    const trap = vi.fn(() => {
      throw new Error("private_proxy_sentinel");
    });
    const proxy = new Proxy(
      {},
      {
        get: trap,
        ownKeys: trap,
        getOwnPropertyDescriptor: trap,
        getPrototypeOf: trap,
      },
    );
    const { payload } = logged(wrapper(proxy));
    expect(payload).not.toHaveProperty("databaseFailure");
    expect(trap).not.toHaveBeenCalled();
  });
  it("does not inspect an outer proxy error", () => {
    const trap = vi.fn(() => {
      throw new Error("private_proxy_sentinel");
    });
    const proxy = new Proxy(wrapper({ code: "23514" }), {
      get: trap,
      ownKeys: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
    });
    const { log } = logged(proxy);
    expect(log).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
  });
  it("inspects at most three cause objects and terminates cycles", () => {
    const deep = wrapper({
      cause: {
        cause: {
          code: "23514",
          constraint: "withdrawal_observation_time_check",
        },
      },
    });
    expect(logged(deep).payload).not.toHaveProperty("databaseFailure");
    vi.restoreAllMocks();
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    expect(logged(wrapper(cycle)).payload).not.toHaveProperty(
      "databaseFailure",
    );
  });
});
