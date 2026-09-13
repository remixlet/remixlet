// Entry of the MAIN-world relay content script (relay.js): registered by
// worker/injection.ts once per document that a network:observe remixlet
// might run on, at document_start. Everything it does is in relay.ts.

import { installRelay } from "./relay.js";

installRelay(window);
