// The reply shape every probe run answers with, as one JSON string: the
// template's value serialised on the page side (so it crosses executeScript
// as text and the worker caps it by length), or the error the template threw.
// The worker engine parses exactly this and nothing else.

import type { ProbeResult } from "./probes.js";

export interface ProbeEnvelope {
  ok: boolean;
  value?: string;
  message?: string;
}

/** Envelope a synchronous run: readers that must answer during an event dispatch use this. */
export function envelopeOf(run: () => ProbeResult): string {
  try {
    return okEnvelope(run());
  } catch (error) {
    return errorEnvelope(String(error));
  }
}

/** Envelope a run that may return a promise (the timeout-bearing probes do). */
export async function envelopeOfAsync(run: () => ProbeResult | Promise<ProbeResult>): Promise<string> {
  try {
    return okEnvelope(await run());
  } catch (error) {
    return errorEnvelope(String(error));
  }
}

export function errorEnvelope(message: string): string {
  return JSON.stringify({ ok: false, message } satisfies ProbeEnvelope);
}

function okEnvelope(value: ProbeResult): string {
  return JSON.stringify({ ok: true, value: JSON.stringify(value) } satisfies ProbeEnvelope);
}
