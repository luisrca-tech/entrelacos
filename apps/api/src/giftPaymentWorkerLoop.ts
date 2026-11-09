import type { GiftPaymentWorker } from "./giftPaymentWorker";

export interface GiftPaymentWorkerLoopOptions {
  worker: GiftPaymentWorker;
  nextDueAt(): Promise<number | null>;
  idleDelayMs: number;
  retryDelayMs: number;
  maxRetryDelayMs: number;
}

export interface GiftPaymentWorkerLoop {
  // The same promise represents the entire owned run, including shutdown.
  start(): Promise<void>;
  wake(): void;
  stop(): Promise<void>;
}

interface OwnedRun {
  stopping: boolean;
  wakeRequested: boolean;
  completion: Promise<void>;
  finish(): void;
  wait?: {
    timer: ReturnType<typeof setTimeout>;
    resolve(): void;
  };
}

function releaseWait(run: OwnedRun) {
  const wait = run.wait;
  if (!wait) return;
  run.wait = undefined;
  clearTimeout(wait.timer);
  wait.resolve();
}

export function createGiftPaymentWorkerLoop(
  options: GiftPaymentWorkerLoopOptions,
): GiftPaymentWorkerLoop {
  const { worker, nextDueAt, idleDelayMs, retryDelayMs, maxRetryDelayMs } =
    options;
  const callable = worker?.processNextReceivedPayment;
  if (typeof callable !== "function" || typeof nextDueAt !== "function")
    throw new TypeError("Payment worker loop requires a worker and schedule");
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
        run.wakeRequested = false;
        let delayMs: number | undefined;
        try {
          const { kind } = await processNextReceivedPayment();
          if (run.stopping) break;
          if (kind === "IDLE" || kind === "RETRY" || kind === "UNRESOLVED") {
            const dueAt = await nextDueAt();
            const untilDueMs = dueAt === null ? 0 : dueAt - Date.now();
            if (untilDueMs > 0) delayMs = Math.min(untilDueMs, idleDelayMs);
            else if (dueAt === null && kind === "IDLE") delayMs = idleDelayMs;
          } else {
            delayMs = 0;
          }
        } catch {
          // A failed read is retried without changing persisted financial state.
        }
        if (run.stopping) break;
        if (run.wakeRequested) delayMs = 0;
        if (delayMs === undefined) {
          delayMs = nextRetryDelayMs;
          nextRetryDelayMs = Math.min(maxRetryDelayMs, nextRetryDelayMs * 2);
        } else {
          nextRetryDelayMs = retryDelayMs;
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
      const run: OwnedRun = {
        stopping: false,
        wakeRequested: false,
        completion,
        finish,
      };
      current = run;
      void execute(run);
      return completion;
    },
    wake() {
      if (!current || current.stopping) return;
      current.wakeRequested = true;
      releaseWait(current);
    },
    stop() {
      if (current) {
        current.stopping = true;
        releaseWait(current);
      }
      return completion;
    },
  };
}
