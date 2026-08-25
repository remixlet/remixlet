// Resolution target for shiki modules the manager can never reach (see the
// shiki-slim plugin in build.mjs): the per-theme "@shikijs/themes/*" modules
// (themes come from @pierre/theme — pierre-light/pierre-dark) and the
// "shiki/wasm" binary (the WASM engine is a throwing stub in shiki-slim.ts).
// Without this, esbuild inlines all 65 shiki themes plus the oniguruma
// engine — ~2MB of bundle that no code path can execute.
export default undefined;
