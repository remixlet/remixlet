// Entry of the page-state reader (page-state.js): injected by the worker
// engine into the page's MAIN world before a read_page_state probe, through
// scripting.executeScript. Installs the reader once per document
// (page-state-reader.ts); the ISOLATED runner then reads through it.

import { installPageStateReader } from "./page-state-reader.js";

installPageStateReader(document);
