import type {
  GiftPaymentWorker,
  GiftPaymentWorkerResult,
} from "./giftPaymentWorker";

export interface GiftPaymentWorkerLoopOptions {
  worker: GiftPaymentWorker;
  idleDelayMs: number;
  retryDelayMs: number;
  maxRetryDelayMs: number;
}

export interface GiftPaymentWorkerLoop {
  // The same promise represents the entire owned run, including shutdown.
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface OwnedRun {
  stopping: boolean;
  completion: Promise<void>;
  finish(): void;
  wait?: {
    timer: ReturnType<typeof setTimeout>;
    resolve(): void;
  };
}

export function createGiftPaymentWorkerLoop(
  options: GiftPaymentWorkerLoopOptions,
): GiftPaymentWorkerLoop {
  const { worker, idleDelayMs, retryDelayMs, maxRetryDelayMs } = options;
  const callable = worker?.processNextReceivedPayment;
  if (typeof callable !== "function")
    throw new TypeError("Payment worker loop requires a worker");
  for (const delay of [idleDelayMs, retryDelayMs, maxRetryDelayMs]) {
    if (!Number.isSafeInteger(delay) || delay < 1 || delay > 2_147_483_647)
      throw new RangeError("Payment worker loop delay is invalid");
  }
  if (maxRetryDelayMs < retryDelayMs)
    throw new RangeError("Payment worker loop retry cap is invalid");
  const processNextReceivedPayment = callable.bind(worker);
  let current: OwnedRun | undefined;
  let completion = Promise.resolve();

  async function execute(run: OwnedRun) {
    let nextRetryDelayMs = retryDelayMs;
    try {
      while (!run.stopping) {
        let kind: GiftPaymentWorkerResult["kind"];
        try {
          kind = (await processNextReceivedPayment()).kind;
        } catch {
          // Rejection proves only settlement; it grants no recovery authority.
          kind = "RETRY";
        }
        if (run.stopping) break;
        let delayMs: number;
        switch (kind) {
          case "IDLE":
            delayMs = idleDelayMs;
            nextRetryDelayMs = retryDelayMs;
            break;
          case "POSTED":
          case "OBSERVED":
          case "DUPLICATE":
          case "NO_REGRESSION":
          case "DEAD_LETTER":
            delayMs = 0;
            nextRetryDelayMs = retryDelayMs;
            break;
          default:
            delayMs = nextRetryDelayMs;
            nextRetryDelayMs = Math.min(maxRetryDelayMs, nextRetryDelayMs * 2);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            run.wait = undefined;
            resolve();
          }, delayMs);
          run.wait = { timer, resolve };
        });
      }
    } finally {
      current = undefined;
      run.finish();
    }
  }

  return {
    start() {
      if (current) return current.completion;
      let finish!: () => void;
      completion = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const run: OwnedRun = { stopping: false, completion, finish };
      current = run;
      void execute(run);
      return completion;
    },
    stop() {
      if (current) {
        current.stopping = true;
        const wait = current.wait;
        if (wait) {
          current.wait = undefined;
          clearTimeout(wait.timer);
          wait.resolve();
        }
      }
      return completion;
    },
  };
}
