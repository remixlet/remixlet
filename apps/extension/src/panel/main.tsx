// Panel entry: mount the React app. All behavior lives in app.tsx; this file
// only wires the document (theme class, root node).

import { createRoot } from "react-dom/client";
import { followThemePreference } from "../ui/theme.js";
import { App } from "./app.js";

followThemePreference();
createRoot(document.getElementById("root")!).render(<App />);
