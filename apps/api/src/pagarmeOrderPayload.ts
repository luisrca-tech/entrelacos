import {
  type CouplesSplitMode,
  couplesSplitAmountCents,
  GIFT_PLATFORM_TARIFFS,
  type GiftCheckoutBuyer,
  giftCheckoutBuyerSchema,
  giftCheckoutCardTokenSchema,
} from "@entrelacos/contracts";
import { pagarmeRecipientIdPattern } from "./pagarmeIds";

/** Card statement text (Pagar.me limit: 13 characters, letters only here). */
export const PAGARME_STATEMENT_DESCRIPTOR = "ENTRELACOS";

export interface PagarmeOrderCommand {
  /** Our checkout attempt id: the order `code` and the Idempotency-Key. */
  readonly checkoutId: string;
  readonly giftId: string;
  readonly giftTitle: string;
  readonly method: "PIX" | "CREDIT_CARD";
  readonly installments: number;
  /** G: what the guest pays (frozen quote total). */
  readonly totalCents: number;
  /** C: the couple amount frozen with the quote settlement. */
  readonly coupleSplitCents: number;
  readonly cardToken?: string;
  readonly quoteExpiresAt: Date;
  readonly now: Date;
  readonly buyer: GiftCheckoutBuyer;
  readonly platformRecipientId: string;
  readonly coupleRecipientId: string;
  readonly splitMode?: CouplesSplitMode;
}

export interface PagarmeSplitRule {
  recipient_id: string;
  type: "flat";
  amount: number;
  options: {
    liable: boolean;
    charge_processing_fee: boolean;
    charge_remainder_fee: boolean;
  };
}

export interface PagarmeOrderPayment {
  payment_method: "pix" | "credit_card";
  amount: number;
  pix?: { expires_in: number };
  credit_card?: {
    card_token: string;
    installments: number;
    statement_descriptor: string;
    operation_type: "auth_and_capture";
  };
  split: PagarmeSplitRule[];
}

export interface PagarmeOrderBody {
  code: string;
  closed: true;
  customer: {
    name: string;
    email: string;
    document: string;
    document_type: "CPF";
    type: "individual";
    phones: {
      mobile_phone: {
        country_code: "55";
        area_code: string;
        number: string;
      };
    };
  };
  items: {
    amount: number;
    description: string;
    quantity: 1;
    code: string;
  }[];
  payments: PagarmeOrderPayment[];
}

export interface PagarmeOrderRequest {
  readonly body: PagarmeOrderBody;
  readonly idempotencyKey: string;
}

function invalid(reason: string): never {
  throw new RangeError(`Pagar.me order payload is invalid: ${reason}`);
}

const reference = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const recipient = pagarmeRecipientIdPattern;

function cents(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
    invalid(label);
  return value;
}

/**
 * Amounts of the two flat split rules (spec D6). In `charge_total` mode the
 * rules apply to the whole charge: couple C, platform G − C. In
 * `per_installment` mode [to confirm in the sandbox] Pagar.me applies each
 * flat rule to every installment, so both are stated per installment: the
 * installment is ceil(G / n), the couple gets ceil(C / n) of it and the
 * platform the rest.
 */
export function pagarmeSplitAmounts(input: {
  method: "PIX" | "CREDIT_CARD";
  totalCents: number;
  coupleSplitCents: number;
  installments: number;
  splitMode?: CouplesSplitMode;
}): { platformCents: number; coupleCents: number; ruleTotalCents: number } {
  const mode = input.splitMode ?? GIFT_PLATFORM_TARIFFS.couplesSplitMode;
  const perInstallment =
    input.method === "CREDIT_CARD" && mode === "per_installment";
  const ruleTotalCents = perInstallment
    ? Math.ceil(input.totalCents / input.installments)
    : input.totalCents;
  const coupleCents =
    input.method === "CREDIT_CARD"
      ? couplesSplitAmountCents(
          input.coupleSplitCents,
          input.installments,
          mode,
        )
      : input.coupleSplitCents;
  return {
    platformCents: ruleTotalCents - coupleCents,
    coupleCents,
    ruleTotalCents,
  };
}

/**
 * Builds POST /orders for a frozen quote (spec D2): the platform recipient is
 * liable and absorbs processing and remainder fees; the couple receives a flat
 * amount with every option off. Both flat rules always add up to G.
 */
export function buildPagarmeOrderRequest(
  command: PagarmeOrderCommand,
): PagarmeOrderRequest {
  if (!reference.test(command.checkoutId)) invalid("checkout id");
  if (!reference.test(command.giftId)) invalid("gift id");
  const title = command.giftTitle.trim();
  if (!title || title.length > 256) invalid("gift title");
  const buyer = giftCheckoutBuyerSchema.safeParse(command.buyer);
  if (!buyer.success) invalid("buyer");
  if (
    !recipient.test(command.platformRecipientId) ||
    !recipient.test(command.coupleRecipientId) ||
    command.platformRecipientId === command.coupleRecipientId
  )
    invalid("recipients");
  const total = cents(command.totalCents, "total");
  const couple = cents(command.coupleSplitCents, "couple split");
  const installments = command.installments;
  if (
    !Number.isSafeInteger(installments) ||
    installments < 1 ||
    installments > GIFT_PLATFORM_TARIFFS.maxInstallments
  )
    invalid("installments");
  const { coupleCents: coupleAmount, platformCents: platformAmount } =
    pagarmeSplitAmounts({
      method: command.method,
      totalCents: total,
      coupleSplitCents: couple,
      installments,
      ...(command.splitMode ? { splitMode: command.splitMode } : {}),
    });
  if (platformAmount < 1) invalid("split exceeds the total");
  const split: PagarmeSplitRule[] = [
    {
      recipient_id: command.platformRecipientId,
      type: "flat",
      amount: platformAmount,
      options: {
        liable: true,
        charge_processing_fee: true,
        charge_remainder_fee: true,
      },
    },
    {
      recipient_id: command.coupleRecipientId,
      type: "flat",
      amount: coupleAmount,
      options: {
        liable: false,
        charge_processing_fee: false,
        charge_remainder_fee: false,
      },
    },
  ];
  let payment: PagarmeOrderPayment;
  if (command.method === "PIX") {
    if (installments !== 1 || command.cardToken !== undefined)
      invalid("Pix is a single tokenless payment");
    const expiresIn = Math.floor(
      (command.quoteExpiresAt.getTime() - command.now.getTime()) / 1000,
    );
    if (!Number.isSafeInteger(expiresIn) || expiresIn < 1)
      invalid("quote expired");
    payment = {
      payment_method: "pix",
      amount: total,
      pix: { expires_in: expiresIn },
      split,
    };
  } else if (command.method === "CREDIT_CARD") {
    const token = giftCheckoutCardTokenSchema.safeParse(command.cardToken);
    if (!token.success) invalid("card token");
    if (command.quoteExpiresAt.getTime() <= command.now.getTime())
      invalid("quote expired");
    payment = {
      payment_method: "credit_card",
      amount: total,
      credit_card: {
        card_token: token.data,
        installments,
        statement_descriptor: PAGARME_STATEMENT_DESCRIPTOR,
        operation_type: "auth_and_capture",
      },
      split,
    };
  } else {
    return invalid("method");
  }
  const phone = buyer.data.phone;
  return {
    idempotencyKey: command.checkoutId,
    body: {
      code: command.checkoutId,
      closed: true,
      customer: {
        name: buyer.data.name,
        email: buyer.data.email,
        document: buyer.data.cpf,
        document_type: "CPF",
        type: "individual",
        phones: {
          mobile_phone: {
            country_code: "55",
            area_code: phone.slice(0, 2),
            number: phone.slice(2),
          },
        },
      },
      items: [
        {
          amount: total,
          description: title,
          quantity: 1,
          code: command.giftId,
        },
      ],
      payments: [payment],
    },
  };
}
