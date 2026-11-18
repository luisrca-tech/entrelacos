import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  PAGARME_API_BASE_URL,
  PagarmeRejectedError,
} from "./pagarmeHttpClient";
import {
  createPagarmeRecipientClient,
  mapPagarmeRecipientStatus,
  PAGARME_WITHDRAWAL_FEE_CENTS,
  type PagarmeRecipientInput,
  pagarmeWithdrawalTransferCents,
} from "./pagarmeRecipientClient";

const secretKey = "sk_test_fixtureSecret0123456789";

function fixture(name: string): string {
  return readFileSync(
    new URL(`./__fixtures__/pagarme/${name}.json`, import.meta.url),
    "utf8",
  );
}

function respond(...bodies: Array<[number, string]>) {
  const queue = [...bodies];
  return vi.fn<typeof fetch>(async () => {
    const [status, body] = queue.shift() ?? [500, "{}"];
    return new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
  });
}

function call(fetch: ReturnType<typeof respond>, index = 0) {
  const [url, init] = fetch.mock.calls[index] ?? [];
  return {
    url: String(url),
    method: init?.method,
    headers: new Headers(init?.headers),
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
}

const input: PagarmeRecipientInput = {
  name: "MARIA DA SILVA",
  email: "maria@example.test",
  cpf: "26224451990",
  mobilePhone: "21994647568",
  birthDate: "1990-04-12",
  monthlyIncomeCents: 500000,
  professionalOccupation: "Professora",
  address: {
    street: "Av. General Justo",
    streetNumber: "375",
    complement: "Bloco A",
    neighborhood: "Centro",
    city: "Rio de Janeiro",
    state: "RJ",
    zipCode: "20021130",
    referencePoint: "Ao lado da banca",
  },
  bankAccount: {
    bank: "341",
    branchNumber: "1234",
    branchCheckDigit: "6",
    accountNumber: "12345",
    accountCheckDigit: "6",
    type: "checking",
  },
};

describe("Pagar.me recipient client", () => {
  it("creates an individual recipient with the couple's own bank account, manual transfers and full automatic anticipation", async () => {
    const fetch = respond([200, fixture("recipient-created")]);
    const client = createPagarmeRecipientClient({ secretKey, fetch });
    const recipient = await client.createRecipient(
      "receiving-account-1",
      input,
    );
    const request = call(fetch);
    expect(request.url).toBe(`${PAGARME_API_BASE_URL}/recipients`);
    expect(request.method).toBe("POST");
    expect(request.headers.get("idempotency-key")).toBe(
      "recipient:receiving-account-1",
    );
    expect(request.body).toEqual({
      code: "receiving-account-1",
      register_information: {
        type: "individual",
        name: "MARIA DA SILVA",
        email: "maria@example.test",
        document: "26224451990",
        birthdate: "1990-04-12T00:00:00",
        monthly_income: 500000,
        professional_occupation: "Professora",
        phone_numbers: [{ ddd: "21", number: "994647568", type: "mobile" }],
        address: {
          street: "Av. General Justo",
          street_number: "375",
          complementary: "Bloco A",
          neighborhood: "Centro",
          city: "Rio de Janeiro",
          state: "RJ",
          zip_code: "20021130",
          reference_point: "Ao lado da banca",
        },
      },
      default_bank_account: {
        holder_name: "MARIA DA SILVA",
        holder_type: "individual",
        holder_document: "26224451990",
        bank: "341",
        branch_number: "1234",
        branch_check_digit: "6",
        account_number: "12345",
        account_check_digit: "6",
        type: "checking",
      },
      transfer_settings: {
        transfer_enabled: false,
        transfer_interval: "Daily",
        transfer_day: 0,
      },
      automatic_anticipation_settings: {
        enabled: true,
        type: "full",
        volume_percentage: 100,
        delay: null,
      },
    });
    expect(recipient).toEqual({
      id: "rp_fixtureRecipient01",
      code: "receiving-account-1",
      status: "registration",
      document: "26224451990",
      bankAccount: {
        id: "ba_fixtureBankAcct01",
        holderDocument: "26224451990",
        maskedAccount: "Conta **** 3456",
      },
    });
  });

  it("omits an absent address complement instead of sending an empty value", async () => {
    const fetch = respond([200, fixture("recipient-created")]);
    const { complement: _complement, ...address } = input.address;
    await createPagarmeRecipientClient({ secretKey, fetch }).createRecipient(
      "receiving-account-1",
      { ...input, address },
    );
    expect(call(fetch).body.register_information.address).not.toHaveProperty(
      "complementary",
    );
  });

  it("repeats the same code and idempotency key so a retry cannot create a second recipient", async () => {
    const fetch = respond(
      [200, fixture("recipient-created")],
      [200, fixture("recipient-created")],
    );
    const client = createPagarmeRecipientClient({ secretKey, fetch });
    const first = await client.createRecipient("receiving-account-1", input);
    const second = await client.createRecipient("receiving-account-1", input);
    expect(second.id).toBe(first.id);
    expect(call(fetch, 1).headers.get("idempotency-key")).toBe(
      call(fetch, 0).headers.get("idempotency-key"),
    );
    expect(call(fetch, 1).body.code).toBe(call(fetch, 0).body.code);
  });

  it("refuses a recipient answer bound to another code or document", async () => {
    const other = JSON.parse(fixture("recipient-created"));
    other.code = "receiving-account-2";
    const fetch = respond([200, JSON.stringify(other)]);
    await expect(
      createPagarmeRecipientClient({ secretKey, fetch }).createRecipient(
        "receiving-account-1",
        input,
      ),
    ).rejects.toThrow();
  });

  it.each([
    ["cpf", { cpf: "123" }],
    ["phone", { mobilePhone: "12" }],
    ["birth date", { birthDate: "1990-02-31" }],
    ["income", { monthlyIncomeCents: -1 }],
  ])("rejects an invalid %s before calling Pagar.me", async (_label, patch) => {
    const fetch = respond([200, fixture("recipient-created")]);
    await expect(
      createPagarmeRecipientClient({ secretKey, fetch }).createRecipient(
        "receiving-account-1",
        { ...input, ...patch } as PagarmeRecipientInput,
      ),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads a recipient", async () => {
    const fetch = respond([200, fixture("recipient-active")]);
    const recipient = await createPagarmeRecipientClient({
      secretKey,
      fetch,
    }).getRecipient("rp_fixtureRecipient01");
    expect(call(fetch).url).toBe(
      `${PAGARME_API_BASE_URL}/recipients/rp_fixtureRecipient01`,
    );
    expect(call(fetch).method).toBe("GET");
    expect(recipient.status).toBe("active");
  });

  it("creates a short-lived KYC link and returns it without retaining it", async () => {
    const fetch = respond([200, fixture("recipient-kyc-link")]);
    const link = await createPagarmeRecipientClient({
      secretKey,
      fetch,
    }).createKycLink("rp_fixtureRecipient01");
    expect(call(fetch).url).toBe(
      `${PAGARME_API_BASE_URL}/recipients/rp_fixtureRecipient01/kyc_link`,
    );
    expect(call(fetch).method).toBe("POST");
    expect(link).toEqual({
      url: "https://exemplo.com/kyc?token=eyWfwqrnqwrnfoqwntoqwntqw",
      base64QrCode: "PD94bWwgdmVyc2lvbj0iMS4wIj8+PHN2Zy8+",
      expiresAt: "2026-11-18T12:20:00.000Z",
    });
  });

  it("accepts the older KYC link field names", async () => {
    const fetch = respond([
      200,
      JSON.stringify({
        base64: "BJ1B51JK2B51KJ2B5=",
        url: "https://www.pagar.me/kyc/14214214215",
        expiration_date: "2026-11-18T12:20:00.046Z",
      }),
    ]);
    const link = await createPagarmeRecipientClient({
      secretKey,
      fetch,
    }).createKycLink("rp_fixtureRecipient01");
    expect(link.base64QrCode).toBe("BJ1B51JK2B51KJ2B5=");
  });

  it("refuses a KYC link that is not https", async () => {
    const fetch = respond([
      200,
      JSON.stringify({
        url: "javascript:alert(1)",
        base64_qrcode: "AAAA",
        expires_at: "2026-11-18T12:20:00Z",
      }),
    ]);
    await expect(
      createPagarmeRecipientClient({ secretKey, fetch }).createKycLink(
        "rp_fixtureRecipient01",
      ),
    ).rejects.toThrow();
  });

  it("reads available and waiting balances in cents", async () => {
    const fetch = respond([200, fixture("recipient-balance")]);
    const balance = await createPagarmeRecipientClient({
      secretKey,
      fetch,
    }).getBalance("rp_fixtureRecipient01");
    expect(call(fetch).url).toBe(
      `${PAGARME_API_BASE_URL}/recipients/rp_fixtureRecipient01/balance`,
    );
    expect(balance).toEqual({
      availableCents: 25000,
      waitingFundsCents: 12000,
    });
  });

  it("creates a withdrawal of the transfer amount with an idempotency key", async () => {
    const fetch = respond([200, fixture("recipient-withdrawal-pending")]);
    const withdrawal = await createPagarmeRecipientClient({
      secretKey,
      fetch,
    }).createWithdrawal("rp_fixtureRecipient01", 9633, "withdrawal:op-1");
    const request = call(fetch);
    expect(request.url).toBe(
      `${PAGARME_API_BASE_URL}/recipients/rp_fixtureRecipient01/withdrawals`,
    );
    expect(request.method).toBe("POST");
    expect(request.body).toEqual({ amount: 9633 });
    expect(request.headers.get("idempotency-key")).toBe("withdrawal:op-1");
    expect(withdrawal).toEqual({
      id: "with_fixtureWithdraw01",
      amountCents: 9633,
      status: "pending",
      updatedAt: "2026-11-20T10:00:00.000Z",
    });
  });

  it("reads a withdrawal by id", async () => {
    const fetch = respond([200, fixture("recipient-withdrawal-transferred")]);
    const withdrawal = await createPagarmeRecipientClient({
      secretKey,
      fetch,
    }).getWithdrawal("rp_fixtureRecipient01", "with_fixtureWithdraw01");
    expect(call(fetch).url).toBe(
      `${PAGARME_API_BASE_URL}/recipients/rp_fixtureRecipient01/withdrawals/with_fixtureWithdraw01`,
    );
    expect(withdrawal.status).toBe("transferred");
  });

  it("lists payables of one recipient, optionally for one charge", async () => {
    const fetch = respond([200, fixture("payables-list")]);
    const payables = await createPagarmeRecipientClient({
      secretKey,
      fetch,
    }).listPayables("rp_fixtureRecipient01", {
      chargeId: "ch_fixtureCharge0001",
    });
    expect(call(fetch).url).toBe(
      `${PAGARME_API_BASE_URL}/payables?recipient_id=rp_fixtureRecipient01&charge_id=ch_fixtureCharge0001`,
    );
    expect(payables).toEqual([
      {
        id: "1234567",
        status: "waiting_funds",
        amountCents: 1747,
        feeCents: 0,
        anticipationFeeCents: 0,
        installment: 1,
        chargeId: "ch_fixtureCharge0001",
        paymentDate: "2026-12-20T03:00:00.000Z",
      },
      {
        id: "1234568",
        status: "waiting_funds",
        amountCents: 1747,
        feeCents: 0,
        anticipationFeeCents: 0,
        installment: 2,
        chargeId: "ch_fixtureCharge0001",
        paymentDate: "2027-01-20T03:00:00.000Z",
      },
    ]);
  });

  it("rejects unsafe recipient identifiers before any request", async () => {
    const fetch = respond([200, "{}"]);
    const client = createPagarmeRecipientClient({ secretKey, fetch });
    await expect(client.getRecipient("../orders")).rejects.toThrow();
    await expect(client.getBalance("rp_a/b")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("propagates typed rejections", async () => {
    const fetch = respond([422, fixture("error-422-validation")]);
    await expect(
      createPagarmeRecipientClient({ secretKey, fetch }).createWithdrawal(
        "rp_fixtureRecipient01",
        100,
        "withdrawal:op-2",
      ),
    ).rejects.toBeInstanceOf(PagarmeRejectedError);
  });
});

describe("Pagar.me recipient status mapping", () => {
  it.each([
    ["registration", "ONBOARDING", false],
    ["affiliation", "UNDER_REVIEW", false],
    ["active", "APPROVED", true],
    ["refused", "BLOCKED", false],
    ["suspended", "SUSPENDED", false],
    ["blocked", "BLOCKED", false],
    ["inactive", "SUSPENDED", false],
    ["something-new", "UNVERIFIED", false],
  ] as const)("maps %s to %s", (status, state, capable) => {
    expect(mapPagarmeRecipientStatus(status)).toEqual({
      providerAccountState: state,
      receivingCapability: capable,
      withdrawalCapability: capable,
    });
  });
});

describe("Pagar.me withdrawal amounts", () => {
  it("charges the 367-cent fee on top of the transferred amount", () => {
    expect(PAGARME_WITHDRAWAL_FEE_CENTS).toBe(367);
    expect(pagarmeWithdrawalTransferCents(10000)).toBe(9633);
  });
  it.each([0, 1, 367])("refuses a gross amount of %i cents", (amount) => {
    expect(() => pagarmeWithdrawalTransferCents(amount)).toThrow();
  });
});
