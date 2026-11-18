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
export const receivingSetupAccountSchema = z
  .object({
    name: text(128),
    email: z.email().max(254),
    cpf: digits(/^\d{11}$/),
    mobilePhone: digits(/^\d{10,11}$/),
    birthDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(
        (value) =>
          Number.isFinite(Date.parse(value)) &&
          new Date(value).toISOString().slice(0, 10) === value,
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
        referencePoint: text(256),
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
