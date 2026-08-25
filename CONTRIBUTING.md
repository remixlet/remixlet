# Contributing to Remixlet

Thanks for wanting to contribute. A few things to know before your first PR:

## License

Remixlet is licensed under the **GNU AGPL-3.0-only** (see [LICENSE](LICENSE)).

Contributions are accepted under the same license (inbound=outbound): by
submitting a pull request you agree that your contribution is licensed under
the AGPL-3.0-only, and nothing more. There is **no CLA** — no one, the
maintainer included, can ever relicense or close contributed code.

Remixlets you author *with* the extension are entirely your own — the AGPL
covers the extension's code, not the scripts you create using its `rmx.*`
API. License those however you like.

## Development

See the [README](README.md#development) for the dev environment (nix flake +
Taskfile).

## How changes land

This repository is an export of a private development repository, so its
history is one commit per export. Pull requests are reviewed here but never
merged through the GitHub UI — an accepted patch is applied to the
development repository and lands in the next export commit, which closes the
PR and carries your authorship as a `Co-authored-by` trailer.

Keep patches small and focused, and run
`task typecheck && task lint && task test` before submitting.
Well-reported issues — the site, what the
remixlet should do, console errors, a reproduction — are often fixed quickly
even without a patch.
