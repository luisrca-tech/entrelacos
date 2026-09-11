import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTwilioVerifyProvider,
  readTwilioVerifyConfig,
  TwilioVerifyConfigurationError,
} from "./twilioVerify";

const config = {
  accountSid: `AC${"a".repeat(32)}`,
  authToken: "b".repeat(32),
  verifyServiceSid: `VA${"c".repeat(32)}`,
  phoneAllowlist: ["+5511999999999"],
  brazilConfirmed: true,
  trialUsageConfirmed: true,
};

afterEach(() => vi.restoreAllMocks());

describe("Twilio Verify adapter", () => {
  it("requires explicit safeguards before enabling real SMS", () => {
    expect(() =>
      readTwilioVerifyConfig({
        ...config,
        explicitlyAuthorized: false,
      }),
    ).toThrow(TwilioVerifyConfigurationError);
    expect(() =>
      readTwilioVerifyConfig({
        ...config,
        explicitlyAuthorized: true,
        phoneAllowlist: [],
      }),
    ).toThrow(TwilioVerifyConfigurationError);
    expect(
      readTwilioVerifyConfig({ ...config, explicitlyAuthorized: true }),
    ).toEqual(config);
    expect(() =>
      readTwilioVerifyConfig({
        ...config,
        explicitlyAuthorized: true,
        accountSid: config.verifyServiceSid,
      }),
    ).toThrow(TwilioVerifyConfigurationError);
    expect(() =>
      readTwilioVerifyConfig({
        ...config,
        explicitlyAuthorized: true,
        verifyServiceSid: config.accountSid,
      }),
    ).toThrow(TwilioVerifyConfigurationError);
  });

  it("uses the Verify v2 send endpoint and classifies outcomes", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sid: "VE123" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("bad", { status: 400 }))
      .mockResolvedValueOnce(new Response("retry", { status: 503 }));
    const provider = createTwilioVerifyProvider({ ...config });

    await expect(
      provider.send({
        phoneE164: config.phoneAllowlist[0],
        code: "123456",
        challengeId: "challenge-1",
      }),
    ).resolves.toEqual({
      status: "PROVIDER_ACCEPTED",
      providerReference: "VE123",
    });
    await expect(
      provider.send({
        phoneE164: config.phoneAllowlist[0],
        code: "123456",
        challengeId: "challenge-2",
      }),
    ).resolves.toEqual({ status: "FAILED_FINAL", failureCode: "TWILIO_4XX" });
    await expect(
      provider.send({
        phoneE164: config.phoneAllowlist[0],
        code: "123456",
        challengeId: "challenge-3",
      }),
    ).resolves.toEqual({ status: "UNKNOWN", failureCode: "TWILIO_5XX" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      `https://verify.twilio.com/v2/Services/${config.verifyServiceSid}/Verifications`,
    );
    expect(request?.method).toBe("POST");
    expect(request?.headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    const body = String(request?.body);
    expect(body).toContain("To=%2B5511999999999");
    expect(body).toContain("Channel=sms");
    expect(body).not.toContain("123456");
  });

  it("checks the provider and distinguishes approved, declined, and unknown", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "approved" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "denied" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "pending", valid: false }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: "max_attempts_reached", valid: false }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 60202 }), { status: 404 }),
      )
      .mockResolvedValueOnce(new Response("bad", { status: 502 }));
    const provider = createTwilioVerifyProvider({ ...config });

    await expect(
      provider.check({
        phoneE164: config.phoneAllowlist[0],
        code: "123456",
        challengeId: "challenge-1",
      }),
    ).resolves.toEqual({ status: "APPROVED" });
    await expect(
      provider.check({
        phoneE164: config.phoneAllowlist[0],
        code: "654321",
        challengeId: "challenge-2",
      }),
    ).resolves.toEqual({ status: "DECLINED" });
    await expect(
      provider.check({
        phoneE164: config.phoneAllowlist[0],
        code: "654321",
        challengeId: "challenge-3",
      }),
    ).resolves.toEqual({ status: "DECLINED" });
    await expect(
      provider.check({
        phoneE164: config.phoneAllowlist[0],
        code: "654321",
        challengeId: "challenge-4",
      }),
    ).resolves.toEqual({ status: "DECLINED" });
    await expect(
      provider.check({
        phoneE164: config.phoneAllowlist[0],
        code: "654321",
        challengeId: "challenge-5",
      }),
    ).resolves.toEqual({ status: "DECLINED" });
    await expect(
      provider.check({
        phoneE164: config.phoneAllowlist[0],
        code: "654321",
        challengeId: "challenge-6",
      }),
    ).resolves.toEqual({ status: "UNKNOWN", failureCode: "TWILIO_5XX" });
  });

  it("fails closed before fetch for a non-allowlisted phone", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const provider = createTwilioVerifyProvider({ ...config });

    await expect(
      provider.send({
        phoneE164: "+5521999999999",
        code: "123456",
        challengeId: "challenge-1",
      }),
    ).resolves.toEqual({
      status: "FAILED_FINAL",
      failureCode: "PHONE_NOT_ALLOWED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies network failures as unknown without retrying", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network unavailable"));
    const provider = createTwilioVerifyProvider({ ...config });

    await expect(
      provider.send({
        phoneE164: config.phoneAllowlist[0],
        code: "123456",
        challengeId: "challenge-1",
      }),
    ).resolves.toEqual({ status: "UNKNOWN", failureCode: "TWILIO_NETWORK" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
