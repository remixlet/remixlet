// Panel entry: mount the React app. All behavior lives in app.tsx; this file
// only wires the document (theme class, root node).

import { createRoot } from "react-dom/client";
import { ext } from "../platform/ext.js";
import type { PanelToWorker } from "../shared/protocol.js";
import { followThemePreference } from "../ui/theme.js";
import { App } from "./app.js";

// Announce this document before anything else can fail: the worker reads the
// sender to learn which surface the panel landed in, and on Chrome that is the
// only proof the side panel is real rather than a silent no-op. Whoever opened
// the panel is waiting on exactly this (platform/panel-surface.ts).
void ext.runtime.sendMessage({ kind: "panel.hello" } satisfies PanelToWorker).catch(() => {});

followThemePreference();
createRoot(document.getElementById("root")!).render(<App />);
