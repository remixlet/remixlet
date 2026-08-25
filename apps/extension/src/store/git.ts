// The ONE place isomorphic-git enters the bundle: installs its single browser
// requirement (a Buffer global — wiki/design/spike-b-git-opfs.md) before any
// call runs. Import git from here, never from "isomorphic-git" directly.

import { Buffer } from "buffer";
// SAFETY: assigning Buffer once provides the global required by isomorphic-git in browser bundles.
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

import git from "isomorphic-git";

export { git };
export { TREE } from "isomorphic-git";
