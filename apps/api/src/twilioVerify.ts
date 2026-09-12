import { brazilianPhoneE164Schema } from "@entrelacos/contracts";
import type {
  GuestProviderCheckResult,
  GuestProviderResult,
  GuestVerificationProvider,
} from "./guestVerification";

const TWILIO_API_ORIGIN = "https://verify.twilio.com/v2/Services";
const TWILIO_ACCOUNT_SID_PATTERN = /^AC[A-Za-z0-9]{32}$/;
const TWILIO_SERVICE_SID_PATTERN = /^VA[A-Za-z0-9]{32}$/;
const TWILIO_AUTH_TOKEN_PATTERN = /^[A-Za-z0-9]{32,128}$/;
const TWILIO_REQUEST_TIMEOUT_MS = 10_000;

export interface TwilioVerifyConfig {
  accountSid: string;
  authToken: string;
  verifyServiceSid: string;
  phoneAllowlist: readonly string[];
  brazilConfirmed: boolean;
  trialUsageConfirmed: boolean;
}

export type TwilioVerifyConfigInput = {
  accountSid: string;
  authToken: string;
  verifyServiceSid: string;
  phoneAllowlist: readonly string[];
  brazilConfirmed: boolean;
  trialUsageConfirmed: boolean;
  explicitlyAuthorized: boolean;
};

export class TwilioVerifyConfigurationError extends Error {
  constructor(message = "Twilio Verify is not configured for real SMS") {
    super(message);
    this.name = "TwilioVerifyConfigurationError";
  }
}

function validPhone(value: string): boolean {
  return brazilianPhoneE164Schema.safeParse(value).success;
}

export function readTwilioVerifyConfig(
  input: TwilioVerifyConfigInput,
): TwilioVerifyConfig {
  if (!input.explicitlyAuthorized) {
    throw new TwilioVerifyConfigurationError();
  }
  if (
    !TWILIO_ACCOUNT_SID_PATTERN.test(input.accountSid) ||
    !TWILIO_SERVICE_SID_PATTERN.test(input.verifyServiceSid) ||
    !TWILIO_AUTH_TOKEN_PATTERN.test(input.authToken) ||
    input.phoneAllowlist.length === 0 ||
    input.phoneAllowlist.some((phone) => !validPhone(phone)) ||
    input.brazilConfirmed !== true ||
    input.trialUsageConfirmed !== true
  ) {
    throw new TwilioVerifyConfigurationError();
  }
  return {
    accountSid: input.accountSid,
    authToken: input.authToken,
    verifyServiceSid: input.verifyServiceSid,
    phoneAllowlist: [...new Set(input.phoneAllowlist)],
    brazilConfirmed: true,
    trialUsageConfirmed: true,
  };
}

function authorization(config: TwilioVerifyConfig): string {
  return `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`;
}

async function request(
  config: TwilioVerifyConfig,
  endpoint: "Verifications" | "VerificationCheck",
  body: URLSearchParams,
): Promise<Response | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    TWILIO_REQUEST_TIMEOUT_MS,
  );
  try {
    return await fetch(
      `${TWILIO_API_ORIGIN}/${config.verifyServiceSid}/${endpoint}`,
      {
        method: "POST",
        headers: {
          Authorization: authorization(config),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: controller.signal,
      },
    );
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function responseJson(
  response: Response,
): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function allowlisted(config: TwilioVerifyConfig, phoneE164: string): boolean {
  return config.phoneAllowlist.includes(phoneE164);
}

export function createTwilioVerifyProvider(
  input: TwilioVerifyConfig | TwilioVerifyConfigInput,
): GuestVerificationProvider & {
  check(input: {
    phoneE164: string;
    code: string;
    challengeId: string;
  }): Promise<GuestProviderCheckResult>;
} {
  const config =
    "explicitlyAuthorized" in input
      ? readTwilioVerifyConfig(input)
      : readTwilioVerifyConfig({ ...input, explicitlyAuthorized: true });

  return {
    mode: "TWILIO",
    async send({ phoneE164 }): Promise<GuestProviderResult> {
      if (!validPhone(phoneE164) || !allowlisted(config, phoneE164)) {
        return { status: "FAILED_FINAL", failureCode: "PHONE_NOT_ALLOWED" };
      }
      const response = await request(
        config,
        "Verifications",
        new URLSearchParams({ To: phoneE164, Channel: "sms" }),
      );
      if (!response)
        return { status: "UNKNOWN", failureCode: "TWILIO_NETWORK" };
      if (response.status >= 200 && response.status < 300) {
        const body = await responseJson(response);
        return {
          status: "PROVIDER_ACCEPTED",
          ...(typeof body.sid === "string"
            ? { providerReference: body.sid }
            : {}),
        };
      }
      if (response.status >= 400 && response.status < 500) {
        return { status: "FAILED_FINAL", failureCode: "TWILIO_4XX" };
      }
      return { status: "UNKNOWN", failureCode: "TWILIO_5XX" };
    },
    async check({ phoneE164, code }): Promise<GuestProviderCheckResult> {
      if (!validPhone(phoneE164) || !allowlisted(config, phoneE164)) {
        return { status: "UNKNOWN", failureCode: "PHONE_NOT_ALLOWED" };
      }
      const response = await request(
        config,
        "VerificationCheck",
        new URLSearchParams({ To: phoneE164, Code: code }),
      );
      if (!response)
        return { status: "UNKNOWN", failureCode: "TWILIO_NETWORK" };
      const body = await responseJson(response);
      if (response.status >= 500) {
        return { status: "UNKNOWN", failureCode: "TWILIO_5XX" };
      }
      if (response.ok && body.status === "approved") {
        return { status: "APPROVED" };
      }
      if (
        body.code === 60202 ||
        (response.ok &&
          (body.valid === false ||
            body.status === "denied" ||
            body.status === "canceled" ||
            body.status === "expired" ||
            body.status === "failed" ||
            body.status === "deleted" ||
            body.status === "max_attempts_reached"))
      ) {
        return { status: "DECLINED" };
      }
      return { status: "UNKNOWN", failureCode: "TWILIO_UNRECOGNIZED" };
    },
  };
}
