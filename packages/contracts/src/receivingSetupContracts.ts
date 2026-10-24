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
export const receivingSetupConsentVersion = "asaas-receiving-v1";
export const receivingIncomingPixDisclosure = {
  version: "asaas-incoming-pix-v1",
  text: "Autorizo o EntreLaços a criar automaticamente uma chave Pix aleatória na minha conta Asaas para receber os presentes. Minha chave bancária será usada apenas como destino de saque e não será transferida para o Asaas.",
} as const;
export const receivingIncomingPixConsentSchema = z
  .object({
    id: identifier,
    version: z.literal(receivingIncomingPixDisclosure.version),
    accountId: identifier,
    userId: identifier,
    sessionId: identifier,
    authenticatedAt: z.iso.datetime(),
    acceptedAt: z.iso.datetime(),
  })
  .strict();
export type ReceivingIncomingPixConsent = z.infer<
  typeof receivingIncomingPixConsentSchema
>;
export const receivingSetupDisclosure = {
  id: "entrelacos-asaas-receiving",
  version: receivingSetupConsentVersion,
  text: "A conta de recebimento será aberta no Asaas em meu nome. Autorizo o envio dos dados deste formulário ao Asaas para cadastro e verificação. A aprovação e eventuais documentos serão solicitados pelo Asaas. Esta confirmação não libera pagamentos ou saques. Em Sandbox, as operações são de teste e não movimentam dinheiro real.",
} as const;
export const receivingSetupAccountSchema = z
  .object({
    name: text(256),
    email: z.email().max(254),
    cpfCnpj: z.string().regex(/^\d{11}$/),
    mobilePhone: z.string().regex(/^\d{10,11}$/),
    incomeValue: z
      .number()
      .finite()
      .nonnegative()
      .refine((value) => Number.isSafeInteger(value * 100)),
    address: text(256),
    addressNumber: text(32),
    province: text(256),
    postalCode: z.string().regex(/^\d{8}$/),
    birthDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(
        (value) =>
          Number.isFinite(Date.parse(value)) &&
          new Date(value).toISOString().slice(0, 10) === value,
      ),
  })
  .strict();
export const receivingSetupInputSchema = z
  .object({
    policyVersion: identifier,
    consentVersion: z.literal(receivingSetupConsentVersion),
    confirmHolder: z.literal(true),
    consentToAsaas: z.literal(true),
    pixConsentVersion: z
      .literal(receivingIncomingPixDisclosure.version)
      .optional(),
    account: receivingSetupAccountSchema,
  })
  .strict();
export const receivingSetupHolderInputSchema = z
  .object({ holderUserId: identifier })
  .strict();
const nativeStatus = z.enum([
  "PENDING",
  "AWAITING_APPROVAL",
  "APPROVED",
  "REJECTED",
]);
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
    pixConsentRecorded: z.boolean().optional(),
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
        commercialInfo: nativeStatus,
        bankAccountInfo: nativeStatus,
        documentation: nativeStatus,
        general: nativeStatus,
        commercialInfoExpired: z.boolean().nullable(),
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
  .object({
    confirmIncomingAccount: z.literal(true),
    pixConsentVersion: z
      .literal(receivingIncomingPixDisclosure.version)
      .optional(),
  })
  .strict();
