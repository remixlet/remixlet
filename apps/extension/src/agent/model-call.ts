// One model call, bounded and retried: the wrapper between pi's agent loop
// and the provider stream function. Imports pi types like pi-runtime.ts and
// providers.ts do; nothing outside src/agent/ sees them.
//
// Why a wrapper and not pi's own retries or `agent.continue()`: the adapters'
// `maxRetries` loop is silent (no callback, no event), covers only the request
// phase (a stream that answers with headers and then goes quiet is never
// retried), and honours server-requested delays of up to a minute. pi's
// `agent.continue()` re-enters the loop from outside prompt(): it needs the
// failed assistant message stripped first, re-emits turn_start, and lets a
// failed attempt reach the session log. Wrapping the stream function keeps a
// retry inside the ONE model call pi asked for — it sees a single stream whose
// events come from whichever attempt answered, with the context (every tool
// result) untouched. The adapters therefore run with maxRetries 0.
//
// What the panel sees: `model_wait` events (types.ts ModelWaitEvent) — issue,
// headers, a tick a second while waiting, each retry with its reason, and one
// `done` when the call settles. The final failure is an ordinary stopReason
// "error" message whose text counts what was tried, so it rides the runtime's
// sole error path (prompt() rejects with a ProviderTurnError).

import type { Api, AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ModelWaitEvent } from "./types.js";

/**
 * Request issued → response headers. A healthy call answers in 1-3 s; the
 * 2026-09-05 stall sat here (or just after) for 2 min 19 s. Nothing is lost
 * by giving up early: no answer has begun.
 */
export const MODEL_CONNECT_MS = 15_000;
/**
 * Longest silence between stream events once headers have arrived. The
 * healthy runs in wiki/design/model-stall-diagnosis-2026-09-05.md put an
 * upper bound of 19 s on that gap (a whole slow turn with 100 reasoning
 * tokens); a false trip costs a retry that discards the words streamed so
 * far, so the budget sits above that bound with margin, not at it.
 */
export const MODEL_STALL_MS = 30_000;
/** Attempts per model call, including the first. */
export const MODEL_ATTEMPTS = 3;
/** Delay before attempt 2, 3, …; the last entry repeats. */
export const MODEL_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000];
/** How often a waiting call reports progress to the panel. */
export const MODEL_WAIT_TICK_MS = 1_000;

export interface ModelCallBudgets {
  connectMs: number;
  stallMs: number;
  attempts: number;
  retryDelaysMs: readonly number[];
}

interface AttemptFailure {
  kind: "failed";
  message: AssistantMessage;
  reason: string;
  retryable: boolean;
}
/** The attempt's stream carried the call to its end: an answer, a terminal error, or the user's Stop. */
interface AttemptSettled {
  kind: "settled";
}
type AttemptOutcome = AttemptFailure | AttemptSettled;

/** Whole seconds for the budgets people read; tests run with sub-second ones. */
const seconds = (ms: number): string => (ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`);

export function withModelCallRetries(
  inner: StreamFn,
  budgets: ModelCallBudgets,
  emit: (event: ModelWaitEvent) => void,
): StreamFn {
  return (model, context, options) => lazyStream(model, async () => attempts(inner, model, context, options, budgets, emit));
}

type StreamOptions = Parameters<StreamFn>[2];

async function* attempts(
  inner: StreamFn,
  model: Model<Api>,
  context: Parameters<StreamFn>[1],
  options: StreamOptions,
  budgets: ModelCallBudgets,
  emit: (event: ModelWaitEvent) => void,
): AsyncGenerator<AssistantMessageEvent> {
  const issuedAt = Date.now();
  const userSignal = options?.signal;
  const maxAttempts = Math.max(1, budgets.attempts);
  // pi pushes a partial assistant message into its context on the FIRST
  // `start` event and replaces it on every later event; a second `start`
  // would push a second message. So `start` is forwarded once per call and a
  // retry's own `start` is swallowed — its content events then replace the
  // earlier attempt's partial in place.
  const forwarded = { start: false };
  let lastFailure: AttemptFailure | undefined;
  let attempted = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (lastFailure !== undefined) {
      const delay = budgets.retryDelaysMs[Math.min(attempt - 2, budgets.retryDelaysMs.length - 1)] ?? 0;
      emit({
        kind: "model_wait",
        phase: "retrying",
        attempt,
        maxAttempts,
        elapsedMs: Date.now() - issuedAt,
        silenceMs: 0,
        reason: lastFailure.reason,
      });
      if (await sleepUnlessAborted(delay, userSignal)) {
        // Stop pressed during the backoff: settle the way an aborted attempt
        // would, so pi's abort handling (and the runtime's) runs unchanged.
        yield abortedEvent(lastFailure.message);
        emit(done(attempted, maxAttempts, issuedAt));
        return;
      }
    }
    attempted = attempt;
    const outcome = yield* runAttempt(inner, model, context, options, budgets, emit, attempt, maxAttempts, issuedAt, forwarded);
    if (outcome.kind === "settled") {
      emit(done(attempt, maxAttempts, issuedAt));
      return;
    }
    lastFailure = outcome;
    if (!outcome.retryable) break;
  }
  // SAFETY: the loop leaves only with a failure recorded — a settled attempt returned above.
  const failure = lastFailure as AttemptFailure;
  // A failure that was never worth retrying keeps the provider's own words
  // (a bad key, a refused request); an exhausted call counts what was tried.
  const text = failure.retryable
    ? `No answer from the model after ${attempted} attempts over ${seconds(Date.now() - issuedAt)} (last: ${failure.reason}). Send the message again to retry.`
    : (failure.message.errorMessage ?? failure.reason);
  const message: AssistantMessage = { ...failure.message, stopReason: "error", errorMessage: text };
  yield { type: "error", reason: "error", error: message };
  emit(done(attempted, maxAttempts, issuedAt));
}

function done(attempt: number, maxAttempts: number, issuedAt: number): ModelWaitEvent {
  return { kind: "model_wait", phase: "done", attempt, maxAttempts, elapsedMs: Date.now() - issuedAt, silenceMs: 0 };
}

async function* runAttempt(
  inner: StreamFn,
  model: Model<Api>,
  context: Parameters<StreamFn>[1],
  options: StreamOptions,
  budgets: ModelCallBudgets,
  emit: (event: ModelWaitEvent) => void,
  attempt: number,
  maxAttempts: number,
  issuedAt: number,
  forwarded: { start: boolean },
): AsyncGenerator<AssistantMessageEvent, AttemptOutcome> {
  const userSignal = options?.signal;
  // The attempt's own signal: the user's Stop reaches it, and so do the two
  // watchdogs — an aborted attempt looks the same to the adapter either way,
  // so `watchdogReason` records which it was before the abort fires.
  const controller = new AbortController();
  const onUserAbort = (): void => controller.abort();
  if (userSignal?.aborted) controller.abort();
  else userSignal?.addEventListener("abort", onUserAbort, { once: true });
  let phase: "connecting" | "streaming" = "connecting";
  let lastActivityAt = Date.now();
  let watchdogReason: string | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number, reason: string): void => {
    if (watchdog !== undefined) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      watchdog = undefined;
      watchdogReason = reason;
      controller.abort();
    }, ms);
  };
  const progress = (): ModelWaitEvent => ({
    kind: "model_wait",
    phase,
    attempt,
    maxAttempts,
    elapsedMs: Date.now() - issuedAt,
    silenceMs: Date.now() - lastActivityAt,
  });
  const ticker = setInterval(() => emit(progress()), MODEL_WAIT_TICK_MS);
  let status: number | undefined;
  arm(budgets.connectMs, `no answer from the model in ${seconds(budgets.connectMs)}`);
  emit(progress());
  try {
    const stream = await inner(model, context, {
      ...options,
      signal: controller.signal,
      // The adapters run their own retry loop only when asked; this wrapper
      // owns retries (see the header comment).
      maxRetries: 0,
      onResponse: async (response, respondingModel) => {
        status = response.status;
        await options?.onResponse?.(response, respondingModel);
      },
    });
    for await (const event of stream) {
      lastActivityAt = Date.now();
      if (event.type === "start") {
        phase = "streaming";
        arm(budgets.stallMs, `the model went quiet for ${seconds(budgets.stallMs)}`);
        emit(progress());
        if (!forwarded.start) {
          forwarded.start = true;
          yield event;
        }
        continue;
      }
      if (event.type === "error") {
        if (userSignal?.aborted) {
          yield event;
          return { kind: "settled" };
        }
        const errorText = event.error.errorMessage ?? "the model returned an error";
        return {
          kind: "failed",
          message: event.error,
          reason: watchdogReason ?? shortReason(errorText),
          retryable: watchdogReason !== undefined || looksTransient(status, errorText),
        };
      }
      if (event.type === "done") {
        yield event;
        return { kind: "settled" };
      }
      arm(budgets.stallMs, `the model went quiet for ${seconds(budgets.stallMs)}`);
      yield event;
    }
    // Every adapter ends with done or error; a stream that just stops is a
    // transport failure in all but name.
    return { kind: "failed", message: errorMessage(model, "the model's answer ended early"), reason: "the model's answer ended early", retryable: true };
  } catch (error) {
    // Setup failed before a stream existed (auth callback, request building).
    const text = error instanceof Error ? error.message : String(error);
    if (userSignal?.aborted) {
      yield abortedEvent(errorMessage(model, text));
      return { kind: "settled" };
    }
    return { kind: "failed", message: errorMessage(model, text), reason: shortReason(text), retryable: looksTransient(status, text) };
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
    clearInterval(ticker);
    userSignal?.removeEventListener("abort", onUserAbort);
  }
}

/**
 * Whether a failed attempt is worth another try. A response status decides
 * when one was seen (the request reached the provider): rate limits and
 * server errors are transient, anything else in the 4xx range is the
 * request's own fault. A 2xx that still failed means the stream broke, which
 * is transient when the message reads like a transport failure and final when
 * the provider sent an error of its own (context too long, refused input).
 * With no status at all the request never got headers; the message tells a
 * network failure from a setup failure (no key, bad option), and an HTTP
 * status quoted in the text is honoured as if it had been seen.
 */
function looksTransient(status: number | undefined, message: string): boolean {
  if (/usage limit|quota|billing|insufficient/i.test(message)) return false;
  if (status !== undefined && (status < 200 || status >= 300)) return transientStatus(status);
  if (status !== undefined) return TRANSPORT_FAILURE.test(message);
  const quoted = /\b([45]\d\d)\b/.exec(message);
  if (quoted) return transientStatus(Number(quoted[1]));
  return TRANSPORT_FAILURE.test(message);
}

const transientStatus = (status: number): boolean => status === 408 || status === 409 || status === 429 || status >= 500;

const TRANSPORT_FAILURE = /fetch|network|socket|connect|terminated|reset|closed|premature|incomplete|time[d ]?out|econn|epipe|eof/i;

function shortReason(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

function abortedEvent(message: AssistantMessage): AssistantMessageEvent {
  return { type: "error", reason: "aborted", error: { ...message, stopReason: "aborted", errorMessage: "Request was aborted" } };
}

/** An empty assistant message carrying an error, for failures the adapter never got to report. */
function errorMessage(model: Model<Api>, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: text,
    timestamp: Date.now(),
  };
}

/** Resolves true when the signal fired before the delay ran out. */
function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(true);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
