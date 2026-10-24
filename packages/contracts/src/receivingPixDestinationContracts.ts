import { z } from "zod";

export const receivingPixKeyTypeSchema = z.enum([
  "CPF",
  "CNPJ",
  "EMAIL",
  "PHONE",
  "EVP",
]);
export const receivingPixDestinationInputSchema = z
  .object({
    type: receivingPixKeyTypeSchema,
    key: z.string().trim().min(1).max(254),
  })
  .strict()
  .superRefine((value, context) => {
    const valid =
      value.type === "CPF"
        ? /^\d{11}$/.test(value.key)
        : value.type === "CNPJ"
          ? /^\d{14}$/.test(value.key)
          : value.type === "PHONE"
            ? /^\d{11}$/.test(value.key)
            : value.type === "EMAIL"
              ? z.email().safeParse(value.key).success
              : z.uuid().safeParse(value.key).success;
    if (!valid)
      context.addIssue({
        code: "custom",
        path: ["key"],
        message: "Invalid Pix key for the selected type",
      });
  });
const text = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      ![...value].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
  );
export const receivingPixDestinationReviewSchema = z
  .object({
    siteId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    mode: z.enum(["sandbox", "live"]),
    keyType: receivingPixKeyTypeSchema,
    maskedKey: text,
    ownerName: text,
    maskedCpfCnpj: text,
    bankName: text,
    identity: z.enum(["MATCH", "MISMATCH", "INCOMPLETE"]),
    observedAt: z.iso.datetime(),
    destinationSaved: z.literal(false),
    withdrawalEnabled: z.literal(false),
    reviewToken: z.string().min(16).max(16384),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type ReceivingPixDestinationInput = z.infer<
  typeof receivingPixDestinationInputSchema
>;
export type ReceivingPixDestinationReview = z.infer<
  typeof receivingPixDestinationReviewSchema
>;
export const receivingPixDestinationConfirmationInputSchema = z
  .object({
    reviewToken: receivingPixDestinationReviewSchema.shape.reviewToken,
    confirmRecipient: z.literal(true),
    acceptThirdParty: z.literal(true).optional(),
    reauthenticationToken: z.string().min(1).max(8192),
  })
  .strict();
export const receivingPixDestinationSavedSchema =
  receivingPixDestinationReviewSchema
    .omit({
      reviewToken: true,
      expiresAt: true,
      observedAt: true,
      destinationSaved: true,
    })
    .extend({
      destinationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
      version: z.number().int().positive().max(2147483647),
      state: z.literal("PENDING"),
    })
    .strict();
export const receivingPixDestinationRecentSchema =
  receivingPixDestinationSavedSchema
    .omit({ state: true, withdrawalEnabled: true })
    .extend({
      maskedKey: text.refine((value) => value.includes("*")),
      maskedCpfCnpj: text.refine((value) => value.includes("*")),
      savedAt: z.iso.datetime(),
    })
    .strict();
export type ReceivingPixDestinationRecent = z.infer<
  typeof receivingPixDestinationRecentSchema
>;
export const receivingPixDestinationSavedResponseSchema = z
  .object({
    destination: receivingPixDestinationSavedSchema.nullable(),
    recentDestinations: z
      .array(receivingPixDestinationRecentSchema)
      .max(5)
      .default([]),
  })
  .strict();
export type ReceivingPixDestinationSaved = z.infer<
  typeof receivingPixDestinationSavedSchema
>;
