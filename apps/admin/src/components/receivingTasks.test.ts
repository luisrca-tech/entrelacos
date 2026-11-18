import { describe, expect, it } from "vitest";
import {
  deriveReceivingTasks,
  identityTaskStatus,
  type ReceivingTasksInput,
  recipientStatusLabel,
} from "./receivingTasks";

const provider: NonNullable<ReceivingTasksInput["provider"]> = {
  recipientStatus: "registration",
  accountState: "ONBOARDING",
  receivingEnabled: false,
};
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

  it("asks for identity verification once the recipient exists", () => {
    expect(
      statuses({ accountState: "CREATED", provider, ready: false }),
    ).toEqual([
      ["recipient", "done"],
      ["identity", "todo"],
      ["ready", "waiting"],
    ]);
  });

  it("follows the Pagar.me review and approval", () => {
    expect(
      statuses({
        accountState: "CREATED",
        provider: { ...provider, accountState: "UNDER_REVIEW" },
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

  it("derives the identity task from the Pagar.me account state", () => {
    expect(identityTaskStatus("APPROVED")).toBe("done");
    expect(identityTaskStatus("UNDER_REVIEW")).toBe("review");
    expect(identityTaskStatus("BLOCKED")).toBe("attention");
    expect(identityTaskStatus("SUSPENDED")).toBe("attention");
    expect(identityTaskStatus("ONBOARDING")).toBe("todo");
    expect(identityTaskStatus("UNVERIFIED")).toBe("todo");
    expect(identityTaskStatus(undefined)).toBe("todo");
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
