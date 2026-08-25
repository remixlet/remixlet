// Entry point for welcome.html — the standalone first-run page. It owns no
// state of its own: WelcomePage recomputes what is and isn't set up from the
// live browser and storage facts every time it loads.

import { createRoot } from "react-dom/client";

import { WelcomePage } from "./onboarding/welcome-page.js";
import { followThemePreference } from "./theme.js";

followThemePreference();
createRoot(document.getElementById("root")!).render(<WelcomePage />);
