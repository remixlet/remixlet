// Entry of the development-time observer content script (dev-observe.js):
// registered by worker/injection.ts over the origins pinned by live
// dev-observe grants, MAIN world, document_start. See dev-observe.ts.

import { installDevObserver } from "./dev-observe.js";

installDevObserver(window);
