import { describe, expect, it } from "vitest";
import {
  deriveReceivingTasks,
  identityStage,
  identityTaskStatus,
  kycStatusLabel,
  type ReceivingTasksInput,
  recipientStatusLabel,
} from "./receivingTasks";

const provider: NonNullable<ReceivingTasksInput["provider"]> = {
  recipientStatus: "registration",
  accountState: "ONBOARDING",
  receivingEnabled: false,
};
type Provider = NonNullable<ReceivingTasksInput["provider"]>;
const affiliation = (
  kycStatus: Provider["kycStatus"],
  kycStatusReason: Provider["kycStatusReason"] = null,
): Provider => ({
  recipientStatus: "affiliation",
  accountState: "UNDER_REVIEW",
  receivingEnabled: false,
  kycStatus,
  kycStatusReason,
});
const asksForSelfie = affiliation(
  "partially_denied",
  "additional_documents_required",
);
const statuses = (input: ReceivingTasksInput) =>
  deriveReceivingTasks(input).map(({ id, status }) => [id, status]);

describe("Pagar.me receiving tasks", () => {
  it("lists the recipient data, identity verification and ready-to-receive steps", () => {
    const tasks = deriveReceivingTasks({
      accountState: "NOT_CREATED",
      provider: null,
      ready: false,
    });
    expect(tasks.map(({ id }) => id)).toEqual([
      "recipient",
      "identity",
      "ready",
    ]);
    expect(tasks.map(({ title }) => title)).toEqual([
      "Dados do recebedor",
      "Verificação de identidade",
      "Pronto para receber",
    ]);
    for (const task of tasks) expect(task.description).not.toBe("");
  });

  it("waits for the recipient before asking for identity verification", () => {
    expect(
      statuses({ accountState: "NOT_CREATED", provider: null, ready: false }),
    ).toEqual([
      ["recipient", "todo"],
      ["identity", "waiting"],
      ["ready", "waiting"],
    ]);
    expect(
      statuses({ accountState: "PENDING", provider: null, ready: false }),
    ).toEqual([
      ["recipient", "todo"],
      ["identity", "waiting"],
      ["ready", "waiting"],
    ]);
  });

  it("flags an uncertain recipient creation", () => {
    expect(
      statuses({ accountState: "UNKNOWN", provider: null, ready: false })[0],
    ).toEqual(["recipient", "attention"]);
  });

  it("waits for the Pagar.me initial analysis once the recipient exists", () => {
    expect(
      statuses({ accountState: "CREATED", provider, ready: false }),
    ).toEqual([
      ["recipient", "done"],
      ["identity", "review"],
      ["ready", "waiting"],
    ]);
    const identity = deriveReceivingTasks({
      accountState: "CREATED",
      provider,
      ready: false,
    })[1];
    expect(identity.description).toContain("até 24 horas");
    expect(identity.description).toContain("Verificar identidade aparece");
  });

  it("asks for the selfie and document only when Pagar.me requests them", () => {
    expect(
      statuses({
        accountState: "CREATED",
        provider: asksForSelfie,
        ready: false,
      })[1],
    ).toEqual(["identity", "todo"]);
  });

  it("follows the Pagar.me review and approval", () => {
    expect(
      statuses({
        accountState: "CREATED",
        provider: affiliation("pending", "in_analysis"),
        ready: false,
      })[1],
    ).toEqual(["identity", "review"]);
    expect(
      statuses({
        accountState: "CREATED",
        provider: {
          recipientStatus: "active",
          accountState: "APPROVED",
          receivingEnabled: true,
        },
        ready: true,
      }),
    ).toEqual([
      ["recipient", "done"],
      ["identity", "done"],
      ["ready", "done"],
    ]);
  });

  it.each([
    ["registration without KYC", provider, "initial_analysis", "review"],
    [
      "affiliation with KYC pending",
      affiliation("pending", "in_analysis"),
      "initial_analysis",
      "review",
    ],
    [
      "affiliation waiting for manual risk analysis",
      affiliation("pending", "waiting_manual_risk_analysis"),
      "initial_analysis",
      "review",
    ],
    [
      "affiliation without KYC details",
      affiliation(null),
      "initial_analysis",
      "review",
    ],
    [
      "affiliation with an undocumented KYC",
      affiliation("unknown", "unknown"),
      "initial_analysis",
      "review",
    ],
    ["affiliation with KYC partially denied", asksForSelfie, "verify", "todo"],
    [
      "affiliation after the selfie was sent",
      affiliation("pending", "answered_waiting_analysis"),
      "documents_review",
      "review",
    ],
    [
      "affiliation with KYC approved",
      affiliation("approved"),
      "documents_review",
      "review",
    ],
    [
      "active with KYC approved",
      {
        recipientStatus: "active",
        accountState: "APPROVED",
        receivingEnabled: true,
        kycStatus: "approved",
        kycStatusReason: null,
      },
      "done",
      "done",
    ],
    [
      "KYC denied",
      affiliation("denied", "fully_denied"),
      "refused",
      "attention",
    ],
    [
      "recipient refused",
      {
        recipientStatus: "refused",
        accountState: "BLOCKED",
        receivingEnabled: false,
      },
      "refused",
      "attention",
    ],
    [
      "recipient blocked",
      { ...provider, recipientStatus: "blocked", accountState: "BLOCKED" },
      "blocked",
      "attention",
    ],
    [
      "recipient suspended",
      { ...provider, recipientStatus: "suspended", accountState: "SUSPENDED" },
      "blocked",
      "attention",
    ],
    ["no observation", null, "initial_analysis", "review"],
  ] as const)(
    "derives the identity stage for %s",
    (_label, input: Provider | null, stage, status) => {
      expect(identityStage(input)).toBe(stage);
      expect(identityTaskStatus(input)).toBe(status);
    },
  );

  it("names every identity check status in Portuguese", () => {
    expect(kycStatusLabel(null)).toBe("Ainda não solicitada");
    expect(kycStatusLabel(undefined)).toBe("Ainda não solicitada");
    expect(kycStatusLabel("pending")).toBe("Em análise");
    expect(kycStatusLabel("partially_denied")).toBe(
      "Aguardando documento e selfie",
    );
    expect(kycStatusLabel("approved")).toBe("Aprovada");
    expect(kycStatusLabel("denied")).toBe("Recusada");
    expect(kycStatusLabel("unknown")).toBe("Situação não reconhecida");
  });

  it("names every Pagar.me recipient status in Portuguese", () => {
    expect(recipientStatusLabel(null)).toBe("Ainda sem resposta da Pagar.me");
    expect(recipientStatusLabel("registration")).toBe("Cadastro recebido");
    expect(recipientStatusLabel("affiliation")).toBe("Em análise");
    expect(recipientStatusLabel("active")).toBe("Ativo");
    expect(recipientStatusLabel("refused")).toBe("Recusado");
    expect(recipientStatusLabel("suspended")).toBe("Suspenso");
    expect(recipientStatusLabel("blocked")).toBe("Bloqueado");
    expect(recipientStatusLabel("inactive")).toBe("Inativo");
  });
});
