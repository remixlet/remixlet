// The per-build stamp both bundles carry. build.mjs replaces this module's
// contents with a fresh id on every (re)build, so a panel and worker loaded
// from the same build agree on the value and any mix of builds does not — the
// page.probe boundary uses that to name "stale worker, fresh panel" states
// instead of letting them masquerade as schema errors. Bundles built straight
// from source (typecheck, browser test suites) keep this fallback, which is
// self-consistent within one bundle.
export const BUILD_ID = "source";
