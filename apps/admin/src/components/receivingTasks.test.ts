import { pagarmeKycStatuses } from "@entrelacos/contracts";
import { describe, expect, it } from "vitest";
import {
  deriveReceivingTasks,
  identityStage,
  identityTaskStatus,
  kycStatusLabel,
  type ReceivingTasksInput,
  recipientStatusLabel,
} from "./receivingTasks";

type Provider = NonNullable<ReceivingTasksInput["provider"]>;
const provider: Provider = {
  recipientStatus: "registration",
  accountState: "ONBOARDING",
  receivingEnabled: false,
};
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
const active: Provider = {
  recipientStatus: "active",
  accountState: "APPROVED",
  receivingEnabled: true,
  kycStatus: "approved",
  kycStatusReason: null,
};
const statuses = (input: ReceivingTasksInput) =>
  deriveReceivingTasks(input).map(({ id, status }) => [id, status]);
const forbidden =
  /selfie|prova de vida|link seguro|QR Code|Verificar identidade/i;

describe("Pagar.me receiving tasks", () => {
  it("lists the couple's data, the bank account and the account status", () => {
    const tasks = deriveReceivingTasks({
      accountState: "NOT_CREATED",
      provider: null,
      ready: false,
    });
    expect(tasks.map(({ id }) => id)).toEqual(["recipient", "bank", "account"]);
    expect(tasks.map(({ title }) => title)).toEqual([
      "Dados do casal",
      "Conta bancária",
      "Status da conta",
    ]);
    expect(tasks[0].description).toContain("declaração");
    for (const task of tasks) {
      expect(task.description).not.toBe("");
      expect(task.description).not.toMatch(forbidden);
    }
  });

  it("waits for the registration before following the account status", () => {
    for (const accountState of ["NOT_CREATED", "PENDING"] as const)
      expect(statuses({ accountState, provider: null, ready: false })).toEqual([
        ["recipient", "todo"],
        ["bank", "todo"],
        ["account", "waiting"],
      ]);
  });

  it("flags an uncertain registration", () => {
    expect(
      statuses({ accountState: "UNKNOWN", provider: null, ready: false }),
    ).toEqual([
      ["recipient", "attention"],
      ["bank", "attention"],
      ["account", "waiting"],
    ]);
  });

  it("follows the activation once the recipient exists", () => {
    const tasks = deriveReceivingTasks({
      accountState: "CREATED",
      provider,
      ready: false,
    });
    expect(tasks.map(({ id, status }) => [id, status])).toEqual([
      ["recipient", "done"],
      ["bank", "done"],
      ["account", "review"],
    ]);
    expect(tasks[2].description).toContain("costuma ser rápida");
    expect(tasks[2].description).not.toContain("24 horas");
  });

  it("marks every task done once receiving is ready", () => {
    expect(
      statuses({ accountState: "CREATED", provider: active, ready: true }),
    ).toEqual([
      ["recipient", "done"],
      ["bank", "done"],
      ["account", "done"],
    ]);
  });

  it("flags an unexpected document request without pointing to Pagar.me", () => {
    const account = deriveReceivingTasks({
      accountState: "CREATED",
      provider: affiliation(
        "partially_denied",
        "additional_documents_required",
      ),
      ready: false,
    })[2];
    expect(account.status).toBe("attention");
    expect(account.description).toContain("pediu documentos");
    expect(account.description).not.toMatch(/https?:|pagar\.me\//i);
    expect(account.description).not.toMatch(forbidden);
  });

  it.each([
    ["no observation", null, "activating", "review"],
    ["registration without KYC", provider, "activating", "review"],
    [
      "affiliation with KYC pending",
      affiliation("pending", "in_analysis"),
      "activating",
      "review",
    ],
    [
      "affiliation waiting for manual risk analysis",
      affiliation("pending", "waiting_manual_risk_analysis"),
      "activating",
      "review",
    ],
    [
      "affiliation answered, waiting for analysis",
      affiliation("pending", "answered_waiting_analysis"),
      "activating",
      "review",
    ],
    [
      "affiliation without KYC details",
      affiliation(null),
      "activating",
      "review",
    ],
    [
      "affiliation with an undocumented KYC",
      affiliation("unknown", "unknown"),
      "activating",
      "review",
    ],
    [
      "affiliation with KYC approved",
      affiliation("approved"),
      "activating",
      "review",
    ],
    [
      "affiliation with KYC partially denied",
      affiliation("partially_denied", "additional_documents_required"),
      "documents_requested",
      "attention",
    ],
    [
      "KYC partially denied without a reason",
      affiliation("partially_denied"),
      "documents_requested",
      "attention",
    ],
    [
      "additional documents required while KYC is pending",
      affiliation("pending", "additional_documents_required"),
      "documents_requested",
      "attention",
    ],
    [
      "registration with KYC partially denied",
      { ...provider, kycStatus: "partially_denied", kycStatusReason: null },
      "documents_requested",
      "attention",
    ],
    ["active with KYC approved", active, "done", "done"],
    [
      "active with a stale document request",
      { ...active, kycStatus: "partially_denied" },
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
      "recipient refused with documents requested",
      {
        recipientStatus: "refused",
        accountState: "BLOCKED",
        receivingEnabled: false,
        kycStatus: "partially_denied",
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
    [
      "recipient inactive",
      { ...provider, recipientStatus: "inactive", accountState: "SUSPENDED" },
      "blocked",
      "attention",
    ],
    [
      "an unrecognized recipient status",
      { ...provider, recipientStatus: null, accountState: "UNVERIFIED" },
      "activating",
      "review",
    ],
  ] as const)(
    "derives the identity stage for %s",
    (_label, input: Provider | null, stage, status) => {
      expect(identityStage(input)).toBe(stage);
      expect(identityTaskStatus(input)).toBe(status);
    },
  );

  it("never asks the couple to act at Pagar.me in any stage", () => {
    for (const recipientStatus of [
      "registration",
      "affiliation",
      "active",
      "refused",
      "suspended",
      "blocked",
      "inactive",
      null,
    ] as const)
      for (const accountState of [
        "UNVERIFIED",
        "ONBOARDING",
        "UNDER_REVIEW",
        "APPROVED",
        "BLOCKED",
        "SUSPENDED",
      ] as const)
        for (const kycStatus of [...pagarmeKycStatuses, null]) {
          const input = {
            recipientStatus,
            accountState,
            receivingEnabled: accountState === "APPROVED",
            kycStatus,
            kycStatusReason: null,
          };
          const status = identityTaskStatus(input);
          expect(["review", "done", "attention"]).toContain(status);
          const [, , account] = deriveReceivingTasks({
            accountState: "CREATED",
            provider: input,
            ready: false,
          });
          expect(account.status).toBe(status);
          expect(account.description).not.toMatch(forbidden);
        }
  });

  it("names every identity check status in Portuguese without promising a selfie", () => {
    expect(kycStatusLabel(null)).toBe("Sem pendências");
    expect(kycStatusLabel(undefined)).toBe("Sem pendências");
    expect(kycStatusLabel("pending")).toBe("Em análise");
    expect(kycStatusLabel("partially_denied")).toBe(
      "Documentos pedidos, fale com o suporte",
    );
    expect(kycStatusLabel("approved")).toBe("Aprovada");
    expect(kycStatusLabel("denied")).toBe("Recusada");
    expect(kycStatusLabel("unknown")).toBe("Situação não reconhecida");
    for (const status of pagarmeKycStatuses)
      expect(kycStatusLabel(status)).not.toMatch(forbidden);
  });

  it("names every Pagar.me recipient status in Portuguese", () => {
    expect(recipientStatusLabel(null)).toBe("Ainda sem resposta da Pagar.me");
    expect(recipientStatusLabel("registration")).toBe("Cadastro recebido");
    expect(recipientStatusLabel("affiliation")).toBe("Em ativação");
    expect(recipientStatusLabel("active")).toBe("Ativo");
    expect(recipientStatusLabel("refused")).toBe("Recusado");
    expect(recipientStatusLabel("suspended")).toBe("Suspenso");
    expect(recipientStatusLabel("blocked")).toBe("Bloqueado");
    expect(recipientStatusLabel("inactive")).toBe("Inativo");
  });
});
