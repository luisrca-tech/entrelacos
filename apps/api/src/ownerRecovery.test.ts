import { describe, expect, it } from "vitest";
import {
  OWNER_RECOVERY_EMAIL_ENV,
  OWNER_RECOVERY_PASSWORD_ENV,
  OWNER_RECOVERY_TARGET_ENV,
  readOwnerRecoveryEnvironment,
} from "./ownerRecovery";

describe("restricted owner recovery configuration", () => {
  it("requires private credentials and a non-production guarded target", () => {
    expect(() => readOwnerRecoveryEnvironment({})).toThrow();
    expect(() =>
      readOwnerRecoveryEnvironment({
        [OWNER_RECOVERY_EMAIL_ENV]: "owner@example.test",
        [OWNER_RECOVERY_PASSWORD_ENV]: "a secure owner password",
        [OWNER_RECOVERY_TARGET_ENV]: "production",
      }),
    ).toThrow(/test or development/);
  });

  it("accepts only test or development target", () => {
    expect(
      readOwnerRecoveryEnvironment({
        [OWNER_RECOVERY_EMAIL_ENV]: " Owner@Example.Test ",
        [OWNER_RECOVERY_PASSWORD_ENV]: "a secure owner password",
        [OWNER_RECOVERY_TARGET_ENV]: "test",
      }),
    ).toEqual({
      email: "Owner@Example.Test",
      password: "a secure owner password",
      target: "test",
    });
  });
});
