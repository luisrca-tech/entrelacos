import {
  type GiftCheckoutBillingAddress,
  type GiftCheckoutBuyer,
  giftCheckoutBillingAddressSchema,
  giftCheckoutBuyerSchema,
} from "@entrelacos/contracts";
import { type PagarmeCardInput, parseCardExpiry } from "./pagarmeCardToken";

/** What the quote form hands over on submit. Never stored or sent as-is. */
export type GiftCheckoutFormInput = {
  buyer: GiftCheckoutBuyer;
  card?: PagarmeCardInput;
  /** Card only: Pagar.me needs it next to the token. Never stored. */
  billingAddress?: GiftCheckoutBillingAddress;
};

/** Card billing address as typed; every part is free text until submit. */
export type GiftCheckoutBillingFields = {
  zipCode: string;
  street: string;
  streetNumber: string;
  complement: string;
  neighborhood: string;
  city: string;
  state: string;
};

export type GiftCheckoutFormFields = {
  name: string;
  cpf: string;
  email: string;
  phone: string;
  cardNumber?: string;
  holderName?: string;
  expiry?: string;
  cvv?: string;
  billing?: GiftCheckoutBillingFields;
};

const digits = (value: string) => value.replace(/[^0-9]/g, "");

export function isValidCpf(value: string): boolean {
  const cpf = digits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const length of [9, 10]) {
    let sum = 0;
    for (let index = 0; index < length; index++)
      sum += Number(cpf[index]) * (length + 1 - index);
    const check = ((sum * 10) % 11) % 10;
    if (check !== Number(cpf[length])) return false;
  }
  return true;
}

/** Luhn check, so obvious typos stay in the form instead of reaching Pagar.me. */
function isValidCardNumber(number: string): boolean {
  if (!/^[0-9]{13,19}$/.test(number)) return false;
  let sum = 0;
  for (let index = 0; index < number.length; index++) {
    let value = Number(number[number.length - 1 - index]);
    if (index % 2 === 1) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
  }
  return sum % 10 === 0;
}

/** Brazilian mobile or landline with DDD; accepts an optional +55 prefix. */
function normalizePhone(value: string): string {
  const phone = digits(value);
  return phone.length > 11 && phone.startsWith("55") ? phone.slice(2) : phone;
}

const line = (value: string) => value.trim().replace(/\s+/g, " ");

const billingErrors: Record<string, string> = {
  zipCode: "Confira o CEP do endereço de cobrança.",
  street: "Informe a rua do endereço de cobrança.",
  streetNumber: "Informe o número do endereço de cobrança.",
  complement: "Confira o complemento do endereço de cobrança.",
  neighborhood: "Informe o bairro do endereço de cobrança.",
  city: "Informe a cidade do endereço de cobrança.",
  state: "Selecione a UF do endereço de cobrança.",
};

function readBillingAddress(
  fields: GiftCheckoutBillingFields | undefined,
): { address: GiftCheckoutBillingAddress } | { error: string } {
  const complement = line(fields?.complement ?? "");
  const address = giftCheckoutBillingAddressSchema.safeParse({
    zipCode: digits(fields?.zipCode ?? ""),
    street: line(fields?.street ?? ""),
    streetNumber: line(fields?.streetNumber ?? ""),
    ...(complement ? { complement } : {}),
    neighborhood: line(fields?.neighborhood ?? ""),
    city: line(fields?.city ?? ""),
    state: line(fields?.state ?? "").toUpperCase(),
  });
  if (address.success) return { address: address.data };
  const field = String(address.error.issues[0]?.path[0] ?? "zipCode");
  return { error: billingErrors[field] ?? billingErrors.zipCode };
}

/**
 * Validates the form. Returns the payment input or a guest-facing message
 * naming the field to fix.
 */
export function readGiftCheckoutForm(
  fields: GiftCheckoutFormFields,
  withCard: boolean,
  now: Date,
): { input: GiftCheckoutFormInput } | { error: string } {
  if (!isValidCpf(fields.cpf)) return { error: "Confira o CPF." };
  const buyer = giftCheckoutBuyerSchema.safeParse({
    name: fields.name.trim().replace(/\s+/g, " "),
    email: fields.email.trim(),
    cpf: digits(fields.cpf),
    phone: normalizePhone(fields.phone),
  });
  if (!buyer.success) {
    const field = buyer.error.issues[0]?.path[0];
    return {
      error:
        field === "email"
          ? "Confira o e-mail."
          : field === "phone"
            ? "Confira o celular com DDD."
            : "Confira o nome completo.",
    };
  }
  if (!withCard) return { input: { buyer: buyer.data } };
  const number = digits(fields.cardNumber ?? "");
  if (!isValidCardNumber(number))
    return { error: "Confira o número do cartão." };
  const holderName = (fields.holderName ?? "").trim().replace(/\s+/g, " ");
  if (holderName.length < 2 || holderName.length > 64)
    return { error: "Confira o nome impresso no cartão." };
  const expiry = parseCardExpiry(fields.expiry ?? "");
  const month = now.getFullYear() * 12 + now.getMonth() + 1;
  if (!expiry || expiry.expYear * 12 + expiry.expMonth < month)
    return { error: "Confira a validade do cartão (MM/AA)." };
  const cvv = digits(fields.cvv ?? "");
  if (!/^[0-9]{3,4}$/.test(cvv)) return { error: "Confira o CVV." };
  const billing = readBillingAddress(fields.billing);
  if ("error" in billing) return billing;
  return {
    input: {
      buyer: buyer.data,
      card: { number, holderName, ...expiry, cvv },
      billingAddress: billing.address,
    },
  };
}
