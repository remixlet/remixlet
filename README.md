# Remixlet

Remix any website with a sentence.

Remixlet is a browser extension with an AI coding agent inside it. Open the
side panel on a page and describe what you want, such as hiding a sidebar,
adding a total row to a table, or keeping a feed chronological. The agent
inspects the live page, writes a remixlet, activates it, and checks the result.

A remixlet is a small set of JavaScript, CSS, and optional network rules. You
can inspect its code, ask the agent to revise it, compare versions, roll back,
disable it, or delete it. It stays in your browser and runs only on the sites
named in its manifest. Learn more at [remixlet.dev](https://remixlet.dev).

## How it works

The agent uses [pi](https://github.com/earendil-works/pi) behind Remixlet's
`AgentRuntime` interface. pi supplies the model adapters and session format.
Remixlet stores conversations as JSONL in the browser's OPFS storage.

You can connect a paid ChatGPT account, use an API key for OpenAI, Anthropic,
Google, or xAI, or configure an OpenAI-compatible endpoint. The extension
talks to that provider directly. Remixlet has no proxy server, and provider
API keys stay in the panel rather than passing through the service worker or
page bridge.

Before its first write in a turn, the agent must capture the page, inspect any
existing remixlets for the site, and record whether the request is feasible.
The Chrome capture contains the DOM, the visible viewport when available, and
a summary of the page's data endpoints. Focused probes can inspect elements,
embedded state, and specific network responses. If the necessary data does
not reach the page, the agent must say so instead of inventing an
approximation.

After activation, the agent verifies the visible result. Interactive controls
must work in both directions, and new UI gets a visual review. A failed check
blocks completion and sends the agent through the remixlet's runtime logs
before another write.

JavaScript remixlets run in a sandboxed extension page. The sandbox exposes
neither the network nor a page handle directly. Remixlets reach the document
through an asynchronous `dom` API policed by an extension-owned page agent.
The optional `rmx.*` services include storage, fetches to approved hosts,
response observation, network rules, menus, clipboard writes, notifications, and schedules. A
remixlet receives one of those services only after the user approves the
named access in the panel.

Each remixlet has its own git repository in OPFS. Every successful write is a
tagged version with a diff, and rolling back moves the active version without
discarding later versions. Activation updates the stored files, runtime,
styles, and network rules as one operation. If any step fails, the previous
version remains active. The service worker keeps no state that cannot be
rebuilt from storage after a restart.

Remixlets carry the version of the `rmx.*` runtime they were built against.
If an older remixlet does not match the installed runtime, Remixlet holds it
for repair instead of running it against an incompatible API.

## Install

Install Remixlet from the
[Chrome Web Store](https://chromewebstore.google.com/detail/remixlet/jidgijjfdffaoobblhnbhcpooojiolkh).
The same build works in Chrome and Chromium browsers that provide Chrome's
side panel, including Microsoft Edge, Brave, Dia, and Helium. Arc is not
supported because its side panel does not display the Remixlet UI. Firefox and
Safari builds are not released yet.

To build the Chrome target locally:

```sh
nix develop          # or run `direnv allow` once
task setup
task build            # unpacked build plus dist/remixlet-chrome-<version>.zip
```

Open `chrome://extensions`, enable Developer mode, choose *Load unpacked*, and
select `apps/extension/dist/chrome/`. This is the unpacked form of the release
candidate zip. Run `task watch` after the first load to rebuild on save and
reload the extension automatically. Run `task build` again before release
testing because watch builds contain development-only code.

## Development

The extension is TypeScript and esbuild creates its browser bundles. Use the
Taskfile from the Nix shell:

```sh
task typecheck
task lint
task test
```

The public checks include per-target platform contracts and lint-boundary
fixtures. [TESTING.md](TESTING.md) describes the private real-Chrome harness
and mock-provider coverage used for releases.

Lint enforces two architectural boundaries. Only
`apps/extension/src/platform/` may access `chrome.*` or `browser.*`, and
provider API keys cannot cross into the worker or bridge.

| Path | Contents |
|---|---|
| `apps/extension/src/agent/` | `AgentRuntime`, pi integration, and provider catalog |
| `apps/extension/src/box/` | Sandboxed JavaScript runtime and mediated page API |
| `apps/extension/src/bridge/` | Page-world relays for approved network observation |
| `apps/extension/src/panel/` | Agent host, chat UI, tools, permissions, and verification |
| `apps/extension/src/platform/` | The only code allowed to touch browser extension APIs |
| `apps/extension/src/shared/` | Protocol types, schemas, host matching, and shared policy |
| `apps/extension/src/store/` | OPFS storage for remixlets, git history, captures, and conversations |
| `apps/extension/src/ui/` | Popup, onboarding, provider settings, and control center |
| `apps/extension/src/worker/` | MV3 coordination, activation, capabilities, schedules, and lifecycle |
| `apps/extension/test/lint/` | Architectural boundary fixtures |
| `apps/extension/test/platform/` | Per-target manifest and capability contracts |
| `packages/design/` | Shared design tokens and brand assets |

## Contributions

This repository is an export of a private development repository, so its
history has one commit per export. Pull requests are reviewed here but never
merged through the GitHub UI. An accepted patch is applied to the development
repository and lands in the next export with its authorship intact. A precise
issue is often as useful as a patch. [CONTRIBUTING.md](CONTRIBUTING.md) explains
the patch flow, and [TESTING.md](TESTING.md) says what a useful report contains.

## License

Remixlet is free software under the GNU AGPL-3.0-only. See
[LICENSE](LICENSE). If you distribute a modified version, or run one that
users interact with over a network, you must make its source available under
the same terms.

Your remixlets are yours. The AGPL covers the extension's code. Scripts you
create with it against the `rmx.*` API are your own work, not derivatives of
the extension, and you can license them however you like.

Contributions use the same license with no CLA. No one, including the
maintainer, can relicense or close contributed code.
