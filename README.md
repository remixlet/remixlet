# Remixlet

Remix any website with a sentence.

Remixlet is a browser extension with an AI coding agent inside it. You open the
panel on a page and describe what you want: hide this sidebar, add a total row
to this table, keep this feed chronological. The agent reads the live page,
writes a remixlet, and turns it on while you watch. A remixlet is a small unit
of JavaScript, CSS, and network rules that you can read, edit, version, and
remove. It is stored in your browser, it runs only on the sites it names, and
it is yours. The web should bend to the person using it, not the other way
around. Learn more at [remixlet.dev](https://remixlet.dev).

## How it works

The agent inside the panel is [pi](https://github.com/earendil-works/pi),
embedded in the extension behind a thin runtime interface. pi has been great
to build on: its unified LLM API is where remixlet's provider list comes from,
and conversations are ordinary pi session files (JSONL), kept in the browser's
own storage. The agent talks directly to a model provider you configure: an
API key for OpenAI, Anthropic, or Google, or a ChatGPT subscription sign-in.
There is no server in between, and keys never leave the panel. Before writing anything, the agent captures the page (DOM
snapshot, optionally a screenshot, the network list, and console output) and
probes it for the facts the feature depends on. A build that needs data the
page does not expose is refused rather than faked, and after a build the agent
verifies its work on the reloaded page; a "Fix this" button hands a failure
straight back to it.

A remixlet is written against `rmx.*`, a small published API that will only
ever gain methods, so a remixlet written today keeps working. Everything beyond
reading and changing the page is a capability: storage, fetching from a named
host, network rules, menus, clipboard, notifications, schedules. Each one names
its scope and does nothing until you click Allow. Remixlets and their full
history live in a git store inside the browser (OPFS), so every change has a
diff and rollback is one click. Activation is atomic and survives browser
restarts. Sharing remixlets between people is deliberately deferred while its
trust model is worked out.

## Install

Remixlet is not on the extension stores yet. Until it is, build it and load it
unpacked:

```sh
nix develop          # or `direnv allow` once
task setup
task build           # → apps/extension/dist/chrome/
```

Then open `chrome://extensions`, enable Developer mode, choose *Load unpacked*,
and pick `apps/extension/dist/chrome/`. `task build:firefox` and
`task build:safari` produce the other targets.

## Browsers

Chrome is the primary target. Firefox has working userScripts, sidebar,
observation, and OAuth backends. Safari is deliberately limited to CSS and the
supported subset of network rules, with a popup panel; anything it cannot do is
shown as disabled, not silently dropped. Automated per-target contracts run in
CI; live Firefox and signed Safari runs are manual release checks.

## Development

TypeScript everywhere; esbuild bundles the extension. `task watch` rebuilds on
save and reloads the loaded extension by itself, in any Chromium browser,
through a build-id server on `127.0.0.1:43117` (override: `RMX_RELOAD_PORT`);
production builds strip the reload client entirely (`src/worker/dev-reload.ts`,
`build.mjs`). If the loaded copy predates a watch build, reload it manually
once to pick up the poller.

`task typecheck`, `task lint`, and `task test` run the checks that ship in this
repository. Lint enforces two boundaries: only `src/platform/` touches
`chrome.*`/`browser.*`, and provider keys cannot cross into the worker or the
bridge. `task test` runs the per-target platform contracts.
[TESTING.md](TESTING.md) describes the rest of the test system.

| Path | What |
|---|---|
| `apps/extension/src/platform/` | The only place `chrome.*`/`browser.*` is touched |
| `apps/extension/src/agent/` | `AgentRuntime` interface and the embedded pi agent (nothing else imports pi) |
| `apps/extension/src/store/` | OPFS/git storage for remixlets and captures |
| `apps/extension/src/worker/` | MV3 service worker: injection, capabilities, schedules |
| `apps/extension/src/panel/` | Agent host and chat UI |
| `apps/extension/src/shared/` | Protocol types and schemas |
| `apps/extension/src/ui/` | Popup, first-run page, manager |
| `apps/extension/test/` | Shipped contract checks: `test/lint/` and `test/platform/` |
| `packages/design/` | Design tokens |

## Contributions

This repository is an export of a private development repository, so its
history is one commit per export. Pull requests are reviewed here but never
merged through the GitHub UI: an accepted patch is applied to the development
repository and lands in the next export with your authorship on the commit. A
precise issue is as valuable as a patch and often faster;
[CONTRIBUTING.md](CONTRIBUTING.md) has the patch flow, and
[TESTING.md](TESTING.md) says what a useful report contains.

## License

Remixlet is free software under the GNU AGPL-3.0-only (see
[LICENSE](LICENSE)). If you distribute a modified version, or run one that
users interact with over a network, you must make its source available under
the same terms.

Your remixlets are yours. The AGPL covers the extension's code. The scripts you
create with it, written against the published `rmx.*` API, are your own work,
not derivatives of the extension, and you can license them however you like.

Contributions are accepted under the same license with no CLA; no one, the
maintainer included, can ever relicense or close contributed code.
