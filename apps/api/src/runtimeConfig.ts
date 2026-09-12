import { brazilianPhoneE164Schema } from "@entrelacos/contracts";
import type { DatabaseTarget } from "@entrelacos/database";
import { readTwilioVerifyConfig } from "./twilioVerify";

function origin(value: string | undefined, name: string): string {
  try {
    const url = new URL(value ?? "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error(`${name} must be an HTTP(S) origin`);
  }
}

function phoneAllowlist(value: string | undefined): string[] {
  const phones = (value ?? "")
    .split(",")
    .map((phone) => phone.trim())
    .filter(Boolean);
  if (
    phones.some((phone) => !brazilianPhoneE164Schema.safeParse(phone).success)
  ) {
    throw new Error(
      "Phone allowlist contains an invalid Brazilian mobile phone",
    );
  }
  return [...new Set(phones)];
}

export function readRuntimeConfig(env: Record<string, string | undefined>) {
  if (env.APP_ENV !== "development" && env.APP_ENV !== "test") {
    throw new Error(
      "APP_ENV must explicitly select development or test; production is not configured",
    );
  }
  const target: DatabaseTarget = env.APP_ENV;
  const port = Number(env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  const secret = env.BETTER_AUTH_SECRET ?? "";
  if (secret.trim().length < 32)
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  const smsModeValue = (env.SMS_MODE ?? "manual").trim().toLowerCase();
  if (
    smsModeValue !== "manual" &&
    smsModeValue !== "simulated" &&
    smsModeValue !== "real"
  ) {
    throw new Error("SMS_MODE must be manual, simulated, or real");
  }
  const smsMode: "manual" | "simulated" | "real" = smsModeValue;
  const fingerprintSecret = (env.GUEST_FINGERPRINT_SECRET ?? secret).trim();
  if (fingerprintSecret.length < 32) {
    throw new Error(
      "GUEST_FINGERPRINT_SECRET must contain at least 32 characters",
    );
  }
  const exposeSimulationCode =
    (env.EXPOSE_SIMULATION_CODE ?? "false").trim().toLowerCase() === "true";
  const trustProxyHeaders =
    (env.TRUST_PROXY_HEADERS ?? "false").trim().toLowerCase() === "true";
  const demoGrantSecret = (
    env.GUEST_DEMO_GRANT_SECRET ?? fingerprintSecret
  ).trim();
  if (demoGrantSecret.length < 32) {
    throw new Error(
      "GUEST_DEMO_GRANT_SECRET must contain at least 32 characters",
    );
  }
  const demoPhoneAllowlist = phoneAllowlist(env.DEMO_PHONE_ALLOWLIST);
  const twilioPhoneAllowlist = phoneAllowlist(env.TWILIO_TEST_PHONE_ALLOWLIST);
  const twilio =
    smsMode === "real"
      ? readTwilioVerifyConfig({
          accountSid: (env.TWILIO_ACCOUNT_SID ?? "").trim(),
          authToken: (env.TWILIO_AUTH_TOKEN ?? "").trim(),
          verifyServiceSid: (env.TWILIO_VERIFY_SERVICE_SID ?? "").trim(),
          phoneAllowlist: twilioPhoneAllowlist,
          explicitlyAuthorized:
            (env.SMS_REAL_AUTHORIZED ?? "false").trim().toLowerCase() ===
            "true",
          brazilConfirmed:
            (env.TWILIO_BRAZIL_CONFIRMED ?? "false").trim().toLowerCase() ===
            "true",
          trialUsageConfirmed:
            (env.TWILIO_TRIAL_USAGE_CONFIRMED ?? "false")
              .trim()
              .toLowerCase() === "true",
        })
      : undefined;
  return {
    target,
    port,
    secret,
    baseURL: origin(env.BETTER_AUTH_URL, "BETTER_AUTH_URL"),
    adminOrigin: origin(env.ADMIN_ORIGIN, "ADMIN_ORIGIN"),
    smsMode,
    fingerprintSecret,
    exposeSimulationCode,
    trustProxyHeaders,
    demoGrantSecret,
    demoPhoneAllowlist,
    twilio,
  };
}
