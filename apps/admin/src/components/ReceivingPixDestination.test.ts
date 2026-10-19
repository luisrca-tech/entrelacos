import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  createReceivingPixDestinationController,
  ReceivingPixDestinationView,
} from "./ReceivingPixDestination";

const review = {
  siteId: "site-one",
  mode: "sandbox",
  keyType: "PHONE",
  maskedKey: "***5839",
  ownerName: "Fictional Holder",
  maskedCpfCnpj: "***.456.789-**",
  bankName: "Test Bank",
  identity: "INCOMPLETE",
  observedAt: "2026-10-16T18:00:00Z",
  destinationSaved: false,
  withdrawalEnabled: false,
  reviewToken: "opaque-review-token-for-testing",
  expiresAt: "2026-10-16T18:05:00Z",
} as const;
const saved = {
  siteId: "site-one",
  mode: "sandbox",
  destinationId: "destination-one",
  version: 1,
  keyType: "PHONE",
  maskedKey: "***5839",
  ownerName: "Fictional Holder",
  maskedCpfCnpj: "***.456.789-**",
  bankName: "Test Bank",
  identity: "INCOMPLETE",
  state: "PENDING",
  withdrawalEnabled: false,
} as const;
function fixture() {
  let current = true,
    suspended = false;
  let clock = Date.parse("2026-10-16T18:00:00Z");
  const suspensionListeners = new Set<() => void>();
  const guard = {
    isCurrent: () => current,
    validate: vi.fn(async () => current),
    subscribeInvalidation: vi.fn(() => () => {}),
  };
  const request = vi.fn(async (): Promise<unknown> => review);
  const publish = vi.fn();
  const controller = createReceivingPixDestinationController(
    "site-one",
    "sandbox",
    guard,
    publish,
    {
      request,
      now: () => clock,
      owner: {
        isSuspended: () => suspended,
        reportFailure: vi.fn(),
        subscribeSuspension: (listener: () => void) => {
          suspensionListeners.add(listener);
          return () => {
            suspensionListeners.delete(listener);
          };
        },
      } as never,
    },
  );
  return {
    controller,
    guard,
    request,
    publish,
    revoke: () => {
      current = false;
    },
    suspend: () => {
      suspended = true;
      for (const listener of suspensionListeners) listener();
    },
    expireReview: () => {
      clock += 300001;
    },
    resume: () => {
      suspended = false;
      for (const listener of suspensionListeners) listener();
    },
  };
}
describe("Pix destination review", () => {
  it("separates the one saved destination from the change form", () => {
    const html = renderToStaticMarkup(
      createElement(ReceivingPixDestinationView, {
        mode: "sandbox",
        state: { status: "ready", review: null, saved },
        enabled: true,
        onConfirm: vi.fn(),
      }),
    );
    expect(html).toContain("Seu destino Pix salvo");
    expect(html).toContain("Alterar destino Pix");
    expect(html).toContain("um destino Pix ativo");
    expect(html).toContain("Celular");
    expect(html).not.toContain("Chave Pix do destinatário");
    expect(html).not.toContain("Salvar destino Pix");
  });
  it("cancels editing without replacing the saved destination or submitting", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    const onConfirm = vi.fn(),
      onLookup = vi.fn(),
      onReset = vi.fn();
    try {
      await act(async () =>
        root.render(
          createElement(ReceivingPixDestinationView, {
            mode: "sandbox",
            state: { status: "ready", review: null, saved },
            enabled: true,
            onConfirm,
            onLookup,
            onReset,
          }),
        ),
      );
      await act(async () =>
        [...node.querySelectorAll("button")]
          .find((button) => button.textContent === "Alterar destino Pix")
          ?.click(),
      );
      expect(node.querySelector('input[type="text"]')).not.toBeNull();
      expect(node.textContent).toContain(saved.maskedKey);
      await act(async () =>
        [...node.querySelectorAll("button")]
          .find((button) => button.textContent === "Cancelar alteração")
          ?.click(),
      );
      expect(node.querySelector('input[type="text"]')).toBeNull();
      expect(node.textContent).toContain(saved.maskedKey);
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onLookup).not.toHaveBeenCalled();
      expect(onReset).toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      node.remove();
    }
  });
  it.each(["MATCH", "MISMATCH"] as const)(
    "requires native recipient consent and conditional third-party consent for %s",
    async (identity) => {
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = true;
      const node = document.createElement("div");
      document.body.append(node);
      const root = createRoot(node);
      const onConfirm = vi.fn();
      try {
        await act(async () =>
          root.render(
            createElement(ReceivingPixDestinationView, {
              mode: "sandbox",
              state: {
                status: "ready",
                review: { ...review, identity },
                saved: null,
              },
              enabled: true,
              onConfirm,
            }),
          ),
        );
        const button = [...node.querySelectorAll("button")].find(
          (value) => value.textContent === "Salvar destino Pix",
        );
        const form = button?.closest("form");
        expect(form).toBeTruthy();
        const boxes = [
          ...node.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
        ];
        expect(boxes).toHaveLength(identity === "MATCH" ? 1 : 2);
        expect(
          boxes.every(
            (box) =>
              box.required && box.getAttribute("aria-required") === "true",
          ),
        ).toBe(true);
        expect(form?.checkValidity()).toBe(false);
        await act(async () =>
          form?.dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          ),
        );
        expect(onConfirm).not.toHaveBeenCalled();
        await act(async () =>
          boxes.forEach((box) => {
            box.click();
          }),
        );
        expect(form?.checkValidity()).toBe(true);
        await act(async () =>
          form?.dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          ),
        );
        expect(onConfirm).toHaveBeenCalledExactlyOnceWith(
          true,
          identity !== "MATCH",
        );
      } finally {
        await act(async () => root.unmount());
        node.remove();
      }
    },
  );
  it("requires a new lookup when a review expires while Chrome is hidden", async () => {
    const v = fixture();
    await v.controller.lookup({ type: "PHONE", key: "47996515839" });
    v.suspend();
    v.expireReview();
    v.resume();
    expect(v.controller.getState()).toMatchObject({
      status: "expired",
      review: null,
    });
    expect(v.controller.guard.isCurrent()).toBe(false);
    v.controller.dispose();
  });
  it("shows third-party confirmation as an available informed choice with both checkboxes initially unchecked", () => {
    const html = renderToStaticMarkup(
      createElement(ReceivingPixDestinationView, {
        mode: "sandbox",
        state: {
          status: "ready",
          review: { ...review, identity: "MISMATCH" },
          saved: null,
        },
        enabled: true,
        onConfirm: vi.fn(),
      }),
    );
    expect(html).toContain("Salvar destino Pix");
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).not.toContain("checked=");
    expect(html).toContain("escolho prosseguir");
  });
  it("shows saved recipient information read-only to OWNER without a key or confirmation form", () => {
    const html = renderToStaticMarkup(
      createElement(ReceivingPixDestinationView, {
        mode: "sandbox",
        state: { status: "ready", review: null, saved },
        enabled: true,
        readOnly: true,
      }),
    );
    expect(html).toContain("Fictional Holder");
    expect(html).toContain("Seu destino Pix salvo");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Salvar destino Pix");
  });
  it("retains an unknown save after Chrome becomes hidden until a saved-destination read", async () => {
    const v = fixture();
    await v.controller.lookup({ type: "PHONE", key: "47996515839" });
    let resolve!: (value: typeof saved) => void;
    v.request.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const work = v.controller.confirm(true, true, () => "real-password-proof");
    await vi.waitFor(() =>
      expect(v.controller.getState().status).toBe("saving"),
    );
    v.suspend();
    resolve(saved);
    await work;
    expect(v.controller.getState()).toMatchObject({
      status: "unknown",
      review: null,
    });
    v.controller.dispose();
  });
  it("expires the review before consuming a password proof or saving", async () => {
    const v = fixture();
    await v.controller.lookup({ type: "PHONE", key: "47996515839" });
    v.expireReview();
    expect(v.controller.guard.isCurrent()).toBe(false);
    const consumeProof = vi.fn(() => "real-password-proof");
    await v.controller.confirm(true, true, consumeProof);
    expect(consumeProof).not.toHaveBeenCalled();
    expect(v.request).toHaveBeenCalledTimes(1);
    v.controller.dispose();
  });
  it("confirms an incompletely identified or third-party destination only after informed consent and real password proof", async () => {
    const v = fixture();
    await v.controller.lookup({ type: "PHONE", key: "47996515839" });
    const consumeProof = vi.fn(() => "real-password-proof");
    await v.controller.confirm(true, false, consumeProof);
    expect(consumeProof).not.toHaveBeenCalled();
    v.request.mockResolvedValueOnce(saved);
    await v.controller.confirm(true, true, consumeProof);
    expect(v.request).toHaveBeenLastCalledWith(
      "/v1/sites/site-one/receiving/pix-destination/confirm",
      {
        method: "POST",
        body: {
          reviewToken: review.reviewToken,
          confirmRecipient: true,
          acceptThirdParty: true,
          reauthenticationToken: "real-password-proof",
        },
      },
    );
    expect(v.controller.getState()).toMatchObject({ saved, review: null });
    expect(v.controller.guard.isCurrent()).toBe(false);
    v.controller.dispose();
  });
  it("requires explicit recipient confirmation and does not save without a password proof", async () => {
    const v = fixture();
    await v.controller.lookup({ type: "PHONE", key: "47996515839" });
    const consumeProof = vi.fn(() => "real-password-proof");
    await v.controller.confirm(false, true, consumeProof);
    expect(consumeProof).not.toHaveBeenCalled();
    await v.controller.confirm(true, true, () => null);
    expect(v.request).toHaveBeenCalledTimes(1);
    v.controller.dispose();
  });
  it("editing the key discards the reviewed receipt and invalidates its password guard", async () => {
    const v = fixture();
    await v.controller.lookup({ type: "PHONE", key: "47996515839" });
    expect(v.controller.guard.isCurrent()).toBe(true);
    v.controller.resetReview();
    expect(v.controller.getState().review).toBeNull();
    expect(v.controller.guard.isCurrent()).toBe(false);
    const consumeProof = vi.fn(() => "real-password-proof");
    await v.controller.confirm(true, true, consumeProof);
    expect(consumeProof).not.toHaveBeenCalled();
    v.controller.dispose();
  });
  it("recovers a saved destination after refresh without reissuing confirmation", async () => {
    const v = fixture();
    v.request.mockResolvedValueOnce({ destination: saved });
    await v.controller.load();
    expect(v.request).toHaveBeenCalledExactlyOnceWith(
      "/v1/sites/site-one/receiving/pix-destination",
    );
    expect(v.controller.getState()).toMatchObject({ saved, review: null });
    v.controller.dispose();
  });
  it("keeps an uncertain save from causing another automatic POST and recovers through a read", async () => {
    const v = fixture();
    await v.controller.lookup({ type: "PHONE", key: "47996515839" });
    v.request.mockRejectedValueOnce(new Error("response lost"));
    await v.controller.confirm(true, true, () => "real-password-proof");
    expect(v.controller.getState()).toMatchObject({ status: "unknown" });
    const count = v.request.mock.calls.length;
    await v.controller.lookup({ type: "PHONE", key: "47996515839" });
    expect(v.request).toHaveBeenCalledTimes(count);
    v.request.mockResolvedValueOnce({ destination: saved });
    await v.controller.load();
    expect(v.controller.getState()).toMatchObject({ saved });
    v.controller.dispose();
  });
  it("shows authentic provider identity without claiming current withdrawal authorization", () => {
    const html = renderToStaticMarkup(
      createElement(ReceivingPixDestinationView, {
        mode: "sandbox",
        state: { status: "ready", review, saved: null },
        enabled: true,
      }),
    );
    expect(html).toContain("Fictional Holder");
    expect(html).toContain("Test Bank");
    expect(html).not.toContain("Saques permanecem bloqueados");
    expect(html).not.toContain("47996515839");
    expect(html).not.toContain("Salvar destino");
    expect(html).not.toContain("Confirmar saque");
  });
  it("validates the current holder before and after lookup and submits no typed identity", async () => {
    const v = fixture();
    await v.controller.lookup({ type: "PHONE", key: "47996515839" });
    expect(v.guard.validate).toHaveBeenCalledTimes(2);
    expect(v.request).toHaveBeenCalledExactlyOnceWith(
      "/v1/sites/site-one/receiving/pix-destination/preview",
      { method: "POST", body: { type: "PHONE", key: "47996515839" } },
    );
    expect(v.controller.getState()).toEqual({
      status: "ready",
      review,
      saved: null,
    });
    v.controller.dispose();
  });
  it("does not contact the provider while session verification is pending", async () => {
    const v = fixture();
    v.suspend();
    await v.controller.lookup({ type: "PHONE", key: "47996515839" });
    expect(v.request).not.toHaveBeenCalled();
    v.controller.dispose();
  });
  it("discards a response arriving after session or holder invalidation", async () => {
    const v = fixture();
    let resolve!: (value: typeof review) => void;
    v.request.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const work = v.controller.lookup({ type: "PHONE", key: "47996515839" });
    await vi.waitFor(() => expect(v.request).toHaveBeenCalled());
    v.revoke();
    resolve(review);
    await work;
    expect(v.controller.getState().review).toBeNull();
    v.controller.dispose();
  });
  it("rejects mismatched response scope instead of displaying another recipient", async () => {
    const v = fixture();
    v.request.mockResolvedValue({ ...review, siteId: "other-site" });
    await v.controller.lookup({ type: "PHONE", key: "47996515839" });
    expect(v.controller.getState()).toEqual({
      status: "unavailable",
      review: null,
      saved: null,
    });
    v.controller.dispose();
  });
  it("does not query an invalid key or accept a forged save/enable response", async () => {
    const v = fixture();
    await v.controller.lookup({ type: "CPF", key: "123" });
    expect(v.request).not.toHaveBeenCalled();
    v.request.mockResolvedValue({
      ...review,
      withdrawalEnabled: true,
    } as never);
    await v.controller.lookup({ type: "PHONE", key: "47996515839" });
    expect(v.controller.getState().review).toBeNull();
    v.controller.dispose();
  });
});
// @vitest-environment jsdom
