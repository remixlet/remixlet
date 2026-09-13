# How Remixlet is tested

Remixlet's agent writes code that changes live pages in your browser. The test system checks the
boundaries and failure modes involved:

- The agent acts on recorded page facts. What a probe observed on the page is written down. The
  agent's decisions are checked against that record, not the user's phrasing or the agent's plan.
- Capabilities are human-gated and reported per browser. A remixlet gets storage, scoped fetch,
  response observation, network rules, menus, clipboard, notifications, or schedules only after
  a person grants them. Each browser target explains its unavailable services instead of silently
  ignoring them.
- JavaScript runs in a sandboxed extension page with no network access or direct page handle. An
  extension-owned page agent mediates each read, write, event, and URL before it reaches the page.
- Activation is atomic and survives restarts. The MV3 service worker can die at any moment, so
  every piece of state must be reconstructible from storage and come back intact.
- Provider API keys stay panel-local. They never move through the service worker or the bridge
  into the page.

## What ships in this repository

Two families of contract checks ship with the source, and public CI runs them on every commit
alongside typecheck, lint, and all three target builds. `task build` produces the same deterministic
Chrome zip that the private release process tests and compares byte for byte before publishing.

The lint boundary contracts (`apps/extension/test/lint/`) run as part of `task lint`:

- Only `src/platform/` may touch `chrome.*`/`browser.*`. Fixtures test the ESLint rule itself.
  Type-only access is allowed. Runtime access hidden in casts or computed lookups is rejected.
- Provider keys must not cross into the worker or the bridge. A static check scans those sources
  for credential references, so the panel-local key promise holds by construction.

The per-target platform contracts (`apps/extension/test/platform/`) run as `task test`:

- Chrome, Firefox, and Safari manifest and capability-gate contracts. Every unavailable
  cross-browser feature has a target-specific reason and enforcement, so the UI matches the
  target's declared behavior.
- Chrome's mediated runtime contract. The packaged sandbox, offscreen host, content-script
  registry, and permission set must stay present without bringing back `userScripts` or a
  page-world code-string lane.

## What stays private

Most of the test system is private and does not ship here. Its core is a real-Chrome harness: a
pinned Chrome for Testing driven over raw CDP, with a fresh headless browser launched per suite.
Twenty-odd suites cover, among other things:

- the OPFS filesystem and isomorphic-git round-trips behind remixlet storage
- the agent runtime against a mock provider that speaks the OpenAI, Codex, Anthropic, Google, and
  xAI-compatible streaming protocols, including their failure modes
- capture and page-probe invariants, the hostile-parameter injection invariant among them
- the DNR net-rule lifecycle: the safe rule subset, isolated persistent IDs, atomic apply and
  removal, and OAuth isolation
- PKCE OAuth flows (Codex subscription sign-in) against a real browser: interception, fallback,
  token refresh
- two-phase restart: every piece of state rehydrates, and per-site pause survives reinstall
- page mediation, capability approval, and trust UI behavior
- onboarding

A few checks stay manual per release: a live Firefox run, a signed Safari build, and a live
Codex subscription smoke test.

## Reporting a bug

You cannot run the private suites, and you do not need to. A precise report often supplies enough
evidence to reproduce the problem in the harness:

- the site you were on
- what you asked the remixlet to do
- what the remixlet actually did
- any console errors
- whether it still happens after a reload

That is usually enough to reproduce the problem against the harness and land a fix in the next
release.
