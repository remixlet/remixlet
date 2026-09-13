// The shape of a probe's params as they cross from the worker into the page:
// JSON, because that is all executeScript's `args` carry, and all the probe
// schemas (shared/probe-schemas.ts) ever validate.

/** JSON-compatible parameter records accepted by the shared probe schemas. */
export type ProbePayloadValue = string | number | boolean | null | ProbePayloadValue[] | ProbePayload;
export interface ProbePayload {
  [name: string]: ProbePayloadValue | undefined;
}
