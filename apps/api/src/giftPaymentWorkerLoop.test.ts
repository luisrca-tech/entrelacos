import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GiftPaymentWorker,
  GiftPaymentWorkerResult,
} from "./giftPaymentWorker";
import {
  createGiftPaymentWorkerLoop,
  type GiftPaymentWorkerLoop,
  type GiftPaymentWorkerLoopOptions,
} from "./giftPaymentWorkerLoop";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const processNextReceivedPayment = vi
    .fn<GiftPaymentWorker["processNextReceivedPayment"]>()
    .mockResolvedValue({ kind: "IDLE" });
  const options: GiftPaymentWorkerLoopOptions = {
    worker: { processNextReceivedPayment },
    idleDelayMs: 100,
    retryDelayMs: 20,
    maxRetryDelayMs: 50,
  };
  return { options, processNextReceivedPayment };
}

async function settle() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

const progressKinds = [
  "POSTED",
  "OBSERVED",
  "DUPLICATE",
  "NO_REGRESSION",
  "DEAD_LETTER",
] as const;

describe("private received payment worker loop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not dispatch or schedule work during construction or stop before start", async () => {
    const values = fixture();
    const loop = createGiftPaymentWorkerLoop(values.options);
    const stopped = loop.stop();
    expect(loop.stop()).toBe(stopped);
    await stopped;
    expect(values.processNextReceivedPayment).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(
    (["idleDelayMs", "retryDelayMs", "maxRetryDelayMs"] as const).flatMap(
      (field) =>
        [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648].map(
          (value) => ({ field, value }),
        ),
    ),
  )(
    "rejects invalid native timer configuration: $field=$value",
    ({ field, value }) => {
      const values = fixture();
      values.options[field] = value;
      expect(() => createGiftPaymentWorkerLoop(values.options)).toThrow();
      expect(values.processNextReceivedPayment).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("rejects a retry cap below its initial delay before dispatch", () => {
    const values = fixture();
    values.options.maxRetryDelayMs = 19;
    expect(() => createGiftPaymentWorkerLoop(values.options)).toThrow();
    expect(values.processNextReceivedPayment).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([null, {}, { processNextReceivedPayment: null }])(
    "rejects an incomplete worker port: %j",
    (worker) => {
      const values = fixture();
      Object.assign(values.options, { worker });
      expect(() => createGiftPaymentWorkerLoop(values.options)).toThrow();
      expect(values.processNextReceivedPayment).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("accepts the native timer upper bound without overflowing to an immediate wait", async () => {
    const values = fixture();
    values.options.idleDelayMs = 2_147_483_647;
    const loop = createGiftPaymentWorkerLoop(values.options);
    loop.start();
    await settle();
    await vi.advanceTimersByTimeAsync(2_147_483_646);
    expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(1);
    await loop.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pins the original callable, receiver, scope and cadence across pending steps, waits and restart", async () => {
    const values = fixture();
    const step = deferred<GiftPaymentWorkerResult>();
    const receiver = {
      scope: "original-account/sandbox",
      processNextReceivedPayment: vi.fn(function (this: { scope: string }) {
        expect(this).toBe(receiver);
        expect(this.scope).toBe("original-account/sandbox");
        return step.promise;
      }),
    };
    values.options.worker = receiver;
    const original = receiver.processNextReceivedPayment;
    const replacement = vi.fn().mockResolvedValue({ kind: "POSTED" });
    const loop = createGiftPaymentWorkerLoop(values.options);
    receiver.processNextReceivedPayment = replacement;
    values.options.worker = {
      scope: "foreign-account/live",
      processNextReceivedPayment: replacement,
    } as GiftPaymentWorker;
    values.options.idleDelayMs = 1;
    values.options.retryDelayMs = 1;
    values.options.maxRetryDelayMs = 1;
    loop.start();
    expect(original).toHaveBeenCalledTimes(1);
    step.resolve({ kind: "IDLE" });
    await settle();
    await vi.advanceTimersByTimeAsync(99);
    expect(original).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(original).toHaveBeenCalledTimes(2);
    await loop.stop();
    const restarted = loop.start();
    expect(original).toHaveBeenCalledTimes(3);
    expect(replacement).not.toHaveBeenCalled();
    expect(loop.stop()).toBe(restarted);
    await restarted;
  });

  it("reads and captures the worker callable once before any asynchronous work", async () => {
    const values = fixture();
    const getter = vi.fn(() => values.processNextReceivedPayment);
    Object.defineProperty(values.options.worker, "processNextReceivedPayment", {
      get: getter,
    });
    const loop = createGiftPaymentWorkerLoop(values.options);
    expect(getter).toHaveBeenCalledTimes(1);
    loop.start();
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(getter).toHaveBeenCalledTimes(1);
    expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it("returns the same run for duplicate starts while a step or wait is owned", async () => {
    const values = fixture();
    const step = deferred<GiftPaymentWorkerResult>();
    values.processNextReceivedPayment.mockReturnValueOnce(step.promise);
    const loop = createGiftPaymentWorkerLoop(values.options);
    const running = loop.start();
    expect(loop.start()).toBe(running);
    expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(1);
    step.resolve({ kind: "IDLE" });
    await settle();
    expect(loop.start()).toBe(running);
    expect(vi.getTimerCount()).toBe(1);
    expect(loop.stop()).toBe(running);
    await running;
  });

  it("establishes run ownership before a reentrant start and repeated stop in dispatch", async () => {
    const values = fixture();
    const step = deferred<GiftPaymentWorkerResult>();
    let loop!: GiftPaymentWorkerLoop;
    let reentrantStart: Promise<void> | undefined;
    let reentrantStop: Promise<void> | undefined;
    values.processNextReceivedPayment.mockImplementationOnce(() => {
      reentrantStart = loop.start();
      reentrantStop = loop.stop();
      expect(loop.stop()).toBe(reentrantStop);
      expect(loop.start()).toBe(reentrantStart);
      return step.promise;
    });
    loop = createGiftPaymentWorkerLoop(values.options);
    const running = loop.start();
    expect(reentrantStart).toBe(running);
    expect(reentrantStop).toBe(running);
    expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(1);
    let drained = false;
    void running.then(() => {
      drained = true;
    });
    await settle();
    expect(drained).toBe(false);
    step.resolve({ kind: "POSTED" });
    await running;
    expect(drained).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "rejection"] as const)(
    "stops admissions immediately but drains a genuine pending %s before restart",
    async (outcome) => {
      const values = fixture();
      const step = deferred<GiftPaymentWorkerResult>();
      const restartedStep = deferred<GiftPaymentWorkerResult>();
      values.processNextReceivedPayment
        .mockReturnValueOnce(step.promise)
        .mockReturnValueOnce(restartedStep.promise);
      const loop = createGiftPaymentWorkerLoop(values.options);
      const running = loop.start();
      const stopped = loop.stop();
      expect(stopped).toBe(running);
      expect(loop.stop()).toBe(stopped);
      expect(loop.start()).toBe(running);
      let drained = false;
      void stopped.then(() => {
        drained = true;
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(drained).toBe(false);
      expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      if (outcome === "success") step.resolve({ kind: "POSTED" });
      else step.reject(new Error("original step rejected"));
      await stopped;
      expect(drained).toBe(true);
      expect(loop.stop()).toBe(stopped);
      expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      const restarted = loop.start();
      expect(restarted).not.toBe(running);
      expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(2);
      expect(loop.stop()).toBe(restarted);
      restartedStep.resolve({ kind: "IDLE" });
      await restarted;
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not release the run in a reentrant settlement callback before loop drainage", async () => {
    const values = fixture();
    const step = deferred<GiftPaymentWorkerResult>();
    let loop!: GiftPaymentWorkerLoop;
    let reentrantStart: Promise<void> | undefined;
    let reentrantStop: Promise<void> | undefined;
    void step.promise.then(() => {
      reentrantStart = loop.start();
      reentrantStop = loop.stop();
    });
    values.processNextReceivedPayment.mockReturnValueOnce(step.promise);
    loop = createGiftPaymentWorkerLoop(values.options);
    const running = loop.start();
    const stopped = loop.stop();
    step.resolve({ kind: "POSTED" });
    await stopped;
    expect(reentrantStart).toBe(running);
    expect(reentrantStop).toBe(stopped);
    expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps shutdown pending forever when the actual worker promise never settles", async () => {
    const values = fixture();
    values.processNextReceivedPayment.mockReturnValueOnce(
      new Promise<GiftPaymentWorkerResult>(() => {}),
    );
    const loop = createGiftPaymentWorkerLoop(values.options);
    const running = loop.start();
    const stopped = loop.stop();
    let drained = false;
    void stopped.then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(drained).toBe(false);
    expect(loop.stop()).toBe(stopped);
    expect(loop.start()).toBe(running);
    expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { kind: "IDLE", delay: 100 },
    { kind: "RETRY", delay: 20 },
    { kind: "UNRESOLVED", delay: 20 },
  ] as const)(
    "waits the configured $delay ms after $kind",
    async ({ kind, delay }) => {
      const values = fixture();
      const next = deferred<GiftPaymentWorkerResult>();
      values.processNextReceivedPayment
        .mockResolvedValueOnce({ kind })
        .mockReturnValueOnce(next.promise);
      const loop = createGiftPaymentWorkerLoop(values.options);
      loop.start();
      await settle();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(2);
      const stopped = loop.stop();
      next.resolve({ kind: "IDLE" });
      await stopped;
    },
  );

  it.each(progressKinds)(
    "yields a native timer after successful progress %s",
    async (kind) => {
      const values = fixture();
      const next = deferred<GiftPaymentWorkerResult>();
      const events: string[] = [];
      values.processNextReceivedPayment
        .mockResolvedValueOnce({ kind })
        .mockImplementationOnce(() => {
          events.push("next step");
          return next.promise;
        });
      const loop = createGiftPaymentWorkerLoop(values.options);
      loop.start();
      setTimeout(() => events.push("other timer"), 0);
      await settle();
      expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(2);
      expect(events).toEqual(["other timer", "next step"]);
      const stopped = loop.stop();
      next.resolve({ kind: "IDLE" });
      await stopped;
    },
  );

  it("uses deterministic capped backoff across retries, unresolved results and rejected steps", async () => {
    const values = fixture();
    values.processNextReceivedPayment
      .mockResolvedValueOnce({ kind: "RETRY" })
      .mockResolvedValueOnce({ kind: "UNRESOLVED" })
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({ kind: "RETRY" });
    const loop = createGiftPaymentWorkerLoop(values.options);
    loop.start();
    await settle();
    for (const [index, delay] of [20, 40, 50, 50].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(
        index + 1,
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(
        index + 2,
      );
    }
    await loop.stop();
  });

  it.each(["IDLE", ...progressKinds] as const)(
    "resets retry backoff after %s",
    async (kind) => {
      const values = fixture();
      values.processNextReceivedPayment
        .mockResolvedValueOnce({ kind: "RETRY" })
        .mockResolvedValueOnce({ kind })
        .mockResolvedValueOnce({ kind: "RETRY" });
      const loop = createGiftPaymentWorkerLoop(values.options);
      loop.start();
      await settle();
      await vi.advanceTimersByTimeAsync(20);
      expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(kind === "IDLE" ? 100 : 1);
      expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(19);
      expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(4);
      await loop.stop();
    },
  );

  it("backs off a synchronous worker throw without losing ownership or rejecting shutdown", async () => {
    const values = fixture();
    values.processNextReceivedPayment.mockImplementationOnce(() => {
      throw new Error("worker unavailable");
    });
    const loop = createGiftPaymentWorkerLoop(values.options);
    loop.start();
    expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(19);
    expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it.each(["IDLE", "RETRY", "UNRESOLVED", ...progressKinds] as const)(
    "interrupts only its actually owned %s timer and memoizes shutdown",
    async (kind) => {
      const values = fixture();
      values.processNextReceivedPayment.mockResolvedValueOnce({ kind });
      const loop = createGiftPaymentWorkerLoop(values.options);
      const running = loop.start();
      await settle();
      const unrelated = vi.fn();
      setTimeout(unrelated, 5_000);
      const clearTimeout = vi.spyOn(globalThis, "clearTimeout");
      const stopped = loop.stop();
      expect(stopped).toBe(running);
      expect(loop.stop()).toBe(stopped);
      expect(loop.start()).toBe(running);
      expect(clearTimeout).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      await stopped;
      expect(loop.stop()).toBe(stopped);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(unrelated).toHaveBeenCalledTimes(1);
      expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not cancel an expired wait or unrelated timer while the next genuine step is pending", async () => {
    const values = fixture();
    const next = deferred<GiftPaymentWorkerResult>();
    values.processNextReceivedPayment
      .mockReturnValueOnce(Promise.resolve({ kind: "IDLE" }))
      .mockReturnValueOnce(next.promise);
    const loop = createGiftPaymentWorkerLoop(values.options);
    loop.start();
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(2);
    const unrelated = vi.fn();
    setTimeout(unrelated, 100);
    const clearTimeout = vi.spyOn(globalThis, "clearTimeout");
    const stopped = loop.stop();
    expect(loop.stop()).toBe(stopped);
    expect(clearTimeout).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    let drained = false;
    void stopped.then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(unrelated).toHaveBeenCalledTimes(1);
    expect(drained).toBe(false);
    next.resolve({ kind: "POSTED" });
    await stopped;
    expect(drained).toBe(true);
    expect(values.processNextReceivedPayment).toHaveBeenCalledTimes(2);
  });
});
