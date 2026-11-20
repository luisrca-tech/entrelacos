import { z } from "zod";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const text = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine(
      (value) =>
        ![...value].some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    );
export const receivingSetupConsentVersion = "pagarme-receiving-v1";
export const receivingSetupDisclosure = {
  id: "entrelacos-pagarme-receiving",
  version: receivingSetupConsentVersion,
  text: "O recebedor será cadastrado na Pagar.me em meu nome, com a minha conta bancária. Autorizo o envio dos dados deste formulário à Pagar.me para cadastro e verificação de identidade. A aprovação e eventuais documentos serão solicitados pela Pagar.me. Esta confirmação não libera pagamentos ou saques. Em teste, as operações não movimentam dinheiro real.",
} as const;
const digits = (pattern: RegExp) => z.string().regex(pattern);

/** CPF check digits (punctuation ignored); repeated digits are invalid. */
export function isValidCpf(value: string): boolean {
  const cpf = value.replace(/[^0-9]/g, "");
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const length of [9, 10]) {
    let sum = 0;
    for (let index = 0; index < length; index++)
      sum += Number(cpf[index]) * (length + 1 - index);
    if (((sum * 10) % 11) % 10 !== Number(cpf[length])) return false;
  }
  return true;
}

/** Whole years between a YYYY-MM-DD birth date and today (UTC). */
function ageInYears(birthDate: string, today = new Date()): number {
  const [year, month, day] = birthDate.split("-").map(Number);
  let age = today.getUTCFullYear() - year;
  const beforeBirthday =
    today.getUTCMonth() + 1 < month ||
    (today.getUTCMonth() + 1 === month && today.getUTCDate() < day);
  if (beforeBirthday) age--;
  return age;
}
/** Pagar.me only registers adult individual recipients. */
const minimumRecipientAge = 18;
export const receivingSetupAccountSchema = z
  .object({
    name: text(128),
    email: z.email().max(254),
    cpf: digits(/^\d{11}$/).refine(isValidCpf),
    mobilePhone: digits(/^\d{10,11}$/),
    birthDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(
        (value) =>
          Number.isFinite(Date.parse(value)) &&
          new Date(value).toISOString().slice(0, 10) === value &&
          ageInYears(value) >= minimumRecipientAge &&
          ageInYears(value) <= 120,
      ),
    monthlyIncomeCents: z.number().int().nonnegative().max(2_147_483_647),
    professionalOccupation: text(128),
    address: z
      .object({
        street: text(256),
        streetNumber: text(32),
        complement: text(128).optional(),
        neighborhood: text(128),
        city: text(128),
        state: digits(/^[A-Z]{2}$/),
        zipCode: digits(/^\d{8}$/),
        referencePoint: text(256).optional(),
      })
      .strict(),
    bankAccount: z
      .object({
        bank: digits(/^\d{3}$/),
        branchNumber: digits(/^\d{1,4}$/),
        branchCheckDigit: digits(/^\d$/).optional(),
        accountNumber: digits(/^\d{1,13}$/),
        accountCheckDigit: digits(/^[0-9Xx]{1,2}$/),
        type: z.enum(["checking", "savings"]),
      })
      .strict(),
  })
  .strict();
export const receivingSetupInputSchema = z
  .object({
    policyVersion: identifier,
    consentVersion: z.literal(receivingSetupConsentVersion),
    confirmHolder: z.literal(true),
    consentToProvider: z.literal(true),
    account: receivingSetupAccountSchema,
  })
  .strict();
export const receivingSetupHolderInputSchema = z
  .object({ holderUserId: identifier })
  .strict();
export const pagarmeRecipientStatuses = [
  "registration",
  "affiliation",
  "active",
  "refused",
  "suspended",
  "blocked",
  "inactive",
] as const;
export const receivingProviderAccountStates = [
  "UNVERIFIED",
  "ONBOARDING",
  "UNDER_REVIEW",
  "APPROVED",
  "BLOCKED",
  "SUSPENDED",
] as const;
export const receivingSetupContextSchema = z
  .object({
    siteId: identifier,
    mode: z.enum(["sandbox", "live"]),
    policyVersion: identifier,
    holder: z
      .object({ userId: identifier, name: z.string().min(1).max(256) })
      .strict()
      .nullable(),
    holderCandidates: z
      .array(
        z
          .object({
            userId: identifier,
            name: z.string().min(1).max(256),
            email: z.email(),
          })
          .strict(),
      )
      .optional(),
    isHolder: z.boolean(),
    consentRecorded: z.boolean(),
    disclosure: z
      .object({
        id: z.literal(receivingSetupDisclosure.id),
        version: z.literal(receivingSetupConsentVersion),
        text: z.literal(receivingSetupDisclosure.text),
      })
      .strict(),
    accountState: z.enum(["NOT_CREATED", "PENDING", "UNKNOWN", "CREATED"]),
    providerStatus: z
      .object({
        // Unknown provider statuses are reported as null and stay UNVERIFIED.
        recipientStatus: z.enum(pagarmeRecipientStatuses).nullable(),
        accountState: z.enum(receivingProviderAccountStates),
        receivingEnabled: z.boolean(),
        observedAt: z.iso.datetime(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (!value.holder && (value.isHolder || value.consentRecorded)) ||
      (value.providerStatus !== null && value.accountState !== "CREATED")
    )
      context.addIssue({
        code: "custom",
        message: "Inconsistent receiving setup context",
      });
  });
export const receivingSetupResponseSchema = z
  .object({ setup: receivingSetupContextSchema })
  .strict();
export const receivingSetupResultSchema = z
  .object({ state: z.enum(["STORED", "UNKNOWN", "UNAVAILABLE"]) })
  .strict();
/**
 * Why Pagar.me definitively refused the recipient (problem
 * `RECEIVING_PROVIDER_REJECTED`): field paths and messages without the
 * submitted values, so the holder can correct the form and resend.
 */
export const receivingProviderRejectionSchema = z
  .object({
    message: z.string().max(300).nullable(),
    fields: z
      .array(
        z
          .object({
            field: z.string().min(1).max(96),
            messages: z.array(z.string().max(240)).max(3),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export type ReceivingProviderRejection = z.infer<
  typeof receivingProviderRejectionSchema
>;
export type ReceivingSetupContext = z.infer<typeof receivingSetupContextSchema>;
export type ReceivingSetupInput = z.infer<typeof receivingSetupInputSchema>;

export const receivingIncomingVerificationInputSchema = z
  .object({ confirmIncomingAccount: z.literal(true) })
  .strict();

/** Short-lived Pagar.me identity verification link; never stored. */
export const receivingKycLinkSchema = z
  .object({
    url: z.url({ protocol: /^https$/ }).max(2048),
    base64QrCode: z
      .string()
      .min(1)
      .max(1_000_000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type ReceivingKycLink = z.infer<typeof receivingKycLinkSchema>;
