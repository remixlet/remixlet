# How remixlet is tested

Remixlet's agent writes code that runs on live pages in your browser. That is only acceptable if
a few promises hold, and the test system is organized around keeping them:

- The agent acts on recorded page facts. What a probe observed on the page is written down, and
  the agent's decisions are checked against that record — not against the user's phrasing, and
  not against the agent's own plan.
- Capabilities are human-gated and honestly reported, per browser. A remixlet gets storage,
  scoped fetch, network rules, menus, clipboard, notifications, or schedules only after a person
  grants them, and each browser target reports what it genuinely supports — Safari's limits
  appear as honest disabled states, not silent failures.
- Activation is atomic and survives restarts. The MV3 service worker can die at any moment, so
  every piece of state must be reconstructible from storage and come back intact.
- Provider API keys stay panel-local. They never move through the service worker or the bridge
  into the page.

## What ships in this repository

Two families of contract checks ship with the source, and public CI runs them on every commit
alongside typecheck, lint, and all three target builds.

The lint boundary contracts (`apps/extension/test/lint/`) run as part of `task lint`:

- Only `src/platform/` may touch `chrome.*`/`browser.*`. The ESLint rule enforcing this is
  itself tested against fixtures — type-only access is allowed, and runtime access smuggled
  through casts or computed lookups is rejected.
- Provider keys must not cross into the worker or the bridge. A static check scans those sources
  for credential references, so the panel-local key promise holds by construction.

The per-target platform contracts (`apps/extension/test/platform/`) run as `task test`:

- Chrome, Firefox, and Safari manifest and capability-gate contracts: every cross-browser
  capability has a target-specific reason and enforcement, so what the UI reports matches what
  each browser can actually do.
- The userScripts unlock gate: which unlock Chrome actually asks for (Developer mode on older
  Chrome, the per-extension "Allow user scripts" toggle from Chrome 138 on), and that a revoked
  script lane stops reporting itself as available instead of trusting a leftover namespace.

## What stays private

Most of the test system is private and does not ship here. Its core is a real-Chrome harness: a
pinned Chrome for Testing driven over raw CDP, with a fresh headless browser launched per suite.
Twenty-odd suites cover, among other things:

- the OPFS filesystem and isomorphic-git round-trips behind remixlet storage
- the agent runtime against a mock provider that speaks the OpenAI, Codex, Anthropic, and Google
  streaming protocols, including their failure modes
- capture and page-probe invariants, the hostile-parameter injection invariant among them
- the DNR net-rule lifecycle: the safe rule subset, isolated persistent IDs, atomic apply and
  removal, and OAuth isolation
- PKCE OAuth flows (Codex subscription sign-in) against a real browser: interception, fallback,
  token refresh
- two-phase restart: every piece of state rehydrates, and per-site pause survives reinstall
- observer-guard and trust-UI behavior
- onboarding

A few checks stay manual per release: a live Firefox run, a signed Safari build, and a live
Codex subscription smoke test.

## Reporting a bug

You cannot run the private suites, and you do not need to — a well-reported issue is often fixed
quickly, sometimes without a patch. The useful ingredients:

- the site you were on
- what you asked the remixlet to do
- what the remixlet actually did
- any console errors
- whether it still happens after a reload

That is usually enough to reproduce the problem against the harness and land a fix in the next
release.
