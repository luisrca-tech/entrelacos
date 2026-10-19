import { isDeepStrictEqual } from "node:util";
import {
  type ReceivingPixDestinationInput,
  type ReceivingPixDestinationReview,
  receivingPixDestinationInputSchema,
  receivingPixDestinationReviewSchema,
} from "@entrelacos/contracts";
import type { FinancialActor } from "./financialAuthorization";
import type { ReceivingSetupAccountRecord } from "./receivingSetupRepository";

export class ReceivingPixDestinationError extends Error {
  constructor(
    readonly status: 400 | 409 | 429 | 503 = 503,
    readonly code = "PIX_DESTINATION_UNAVAILABLE",
  ) {
    super("Pix destination lookup unavailable");
  }
}
function unavailable(): never {
  throw new ReceivingPixDestinationError();
}
function hasControls(value: string): boolean {
  return [...value].some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return unavailable();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 256 ||
    hasControls(value)
  )
    return unavailable();
  return value.trim();
}
function fullTaxId(value: unknown): string | null {
  if (typeof value !== "string" || !/^[\d.\-/\s]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, "");
  return /^\d{11}$|^\d{14}$/.test(digits) ? digits : null;
}
function normalizedName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleUpperCase("pt-BR")
    .replace(/\s+/g, " ")
    .trim();
}
function canonicalKey(
  type: ReceivingPixDestinationInput["type"],
  value: string,
): string {
  if (type === "PHONE") return value.replace(/^\+55/, "");
  if (type === "EMAIL" || type === "EVP") return value.toLowerCase();
  return value;
}
function maskedKey(input: ReceivingPixDestinationInput): string {
  if (input.type === "EMAIL") {
    const [local, domain] = input.key.split("@");
    return `${local.slice(0, 1)}***@${domain.slice(0, 1)}***`;
  }
  return `***${input.key.slice(-4)}`;
}
function maskedTaxId(value: string): string {
  const digits = fullTaxId(value);
  if (digits?.length === 11)
    return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
  if (digits?.length === 14) return `**.***.${digits.slice(5, 8)}/****-**`;
  if (!/^[\d.*\-/\s]+$/.test(value) || !value.includes("*"))
    return unavailable();
  // Preserve only the provider's already masked tax ID, never another returned field.
  return value;
}
async function boundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return unavailable();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const buffer = new Uint8Array(65536);
    let length = 0;
    while (true) {
      if (signal.aborted) return unavailable();
      const chunk = await reader.read();
      if (signal.aborted) return unavailable();
      if (chunk.done) break;
      if (length + chunk.value.length > buffer.length) {
        cancel();
        return unavailable();
      }
      buffer.set(chunk.value, length);
      length += chunk.value.length;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      ),
    );
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
export function createReceivingPixDestinationLookup(options: {
  mode: "sandbox" | "live";
  authorize(actor: FinancialActor): Promise<ReceivingSetupAccountRecord>;
  consume(accountId: string): Promise<boolean>;
  credential(account: ReceivingSetupAccountRecord): string;
  fetch: typeof globalThis.fetch;
  now(): Date;
  issueReview(
    actor: FinancialActor,
    account: ReceivingSetupAccountRecord,
    input: ReceivingPixDestinationInput,
    review: Omit<ReceivingPixDestinationReview, "reviewToken" | "expiresAt">,
  ): Promise<{ reviewToken: string; expiresAt: string }>;
}) {
  const base =
    options.mode === "sandbox"
      ? "https://api-sandbox.asaas.com/v3"
      : "https://api.asaas.com/v3";
  return Object.freeze({
    async lookup(
      actor: FinancialActor,
      rawInput: unknown,
    ): Promise<ReceivingPixDestinationReview> {
      const parsed = receivingPixDestinationInputSchema.safeParse(rawInput);
      if (!parsed.success)
        throw new ReceivingPixDestinationError(400, "PIX_KEY_INVALID");
      const input = parsed.data;
      const account = await options.authorize(actor);
      if (
        !account.result ||
        account.state !== "SUCCEEDED" ||
        account.operatorUserId !== actor.userId
      )
        return unavailable();
      if (
        options.mode === "sandbox" &&
        !(
          (input.type === "PHONE" && input.key === "47996515839") ||
          (input.type === "EMAIL" &&
            input.key === "cliente-a00001@pix.bcb.gov.br")
        )
      )
        throw new ReceivingPixDestinationError(
          409,
          "PIX_SANDBOX_KEY_UNSUPPORTED",
        );
      if (!(await options.consume(account.accountId)))
        throw new ReceivingPixDestinationError(429, "PIX_LOOKUP_RATE_LIMITED");
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 15000);
      try {
        const accessToken = options.credential(account);
        if (!accessToken || /\s/.test(accessToken) || hasControls(accessToken))
          return unavailable();
        async function get(path: string): Promise<Record<string, unknown>> {
          const response = await options.fetch(`${base}${path}`, {
            method: "GET",
            redirect: "error",
            signal: abort.signal,
            headers: {
              access_token: accessToken,
              "User-Agent": "Entrelacos/1.0",
              Accept: "application/json",
            },
          });
          if (
            abort.signal.aborted ||
            response.status !== 200 ||
            response.redirected ||
            !/^application\/json(?:\s*;|$)/i.test(
              response.headers.get("content-type") ?? "",
            )
          ) {
            void response.body?.cancel().catch(() => {});
            return unavailable();
          }
          return object(await boundedJson(response, abort.signal));
        }
        const wallets = await get("/wallets/");
        if (
          !Array.isArray(wallets.data) ||
          wallets.data.length !== 1 ||
          wallets.hasMore === true ||
          object(wallets.data[0]).id !== account.result.recipientReference
        )
          return unavailable();
        const commercial = await get("/myAccount/commercialInfo/");
        const holderName = text(commercial.name);
        const holderTaxId = fullTaxId(commercial.cpfCnpj);
        const query = new URLSearchParams({ type: input.type, key: input.key });
        const external = await get(`/pix/addressKeys/external?${query}`);
        if (
          external.type !== input.type ||
          typeof external.key !== "string" ||
          canonicalKey(input.type, external.key) !==
            canonicalKey(input.type, input.key)
        )
          return unavailable();
        const owner = object(external.owner);
        const ownerName = text(owner.name),
          ownerTaxId = text(owner.cpfCnpj);
        const completeOwnerTaxId = fullTaxId(ownerTaxId);
        const nameMatches =
          normalizedName(ownerName) === normalizedName(holderName);
        const identity =
          !nameMatches ||
          (holderTaxId !== null &&
            completeOwnerTaxId !== null &&
            holderTaxId !== completeOwnerTaxId)
            ? "MISMATCH"
            : holderTaxId !== null && completeOwnerTaxId !== null
              ? "MATCH"
              : "INCOMPLETE";
        const current = await options.authorize(actor);
        if (
          current.accountId !== account.accountId ||
          current.state !== "SUCCEEDED" ||
          current.operatorUserId !== actor.userId ||
          !isDeepStrictEqual(current.result, account.result) ||
          abort.signal.aborted
        )
          return unavailable();
        const observedAt = options.now();
        if (
          !(observedAt instanceof Date) ||
          !Number.isSafeInteger(observedAt.getTime()) ||
          observedAt.getTime() < 0
        )
          return unavailable();
        const review = receivingPixDestinationReviewSchema
          .omit({ reviewToken: true, expiresAt: true })
          .parse({
            siteId: actor.siteId,
            mode: options.mode,
            keyType: input.type,
            maskedKey: maskedKey(input),
            ownerName,
            maskedCpfCnpj: maskedTaxId(ownerTaxId),
            bankName: text(
              external.ispbName ?? object(external.financialInstitution).name,
            ),
            identity,
            observedAt: observedAt.toISOString(),
            destinationSaved: false,
            withdrawalEnabled: false,
          });
        const receipt = await options.issueReview(
          actor,
          account,
          input,
          review,
        );
        return receivingPixDestinationReviewSchema.parse({
          ...review,
          ...receipt,
        });
      } catch {
        return unavailable();
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}
export type ReceivingPixDestinationLookup = ReturnType<
  typeof createReceivingPixDestinationLookup
>;
