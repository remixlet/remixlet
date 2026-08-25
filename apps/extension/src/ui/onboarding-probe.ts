// The userScripts availability probe (loaded by probe.html inside an iframe
// on the onboarding page). Availability of chrome.userScripts is decided when
// a JS context is CREATED, so a long-lived page can never observe the toggle
// flipping — but a freshly created document can. The onboarding page remounts
// this iframe every poll tick and reads the answer via postMessage.

import { userScriptsUnlocked } from "../platform/capabilities.js";

window.parent.postMessage({ kind: "rmx.userScriptsProbe", unlocked: userScriptsUnlocked() }, "*");
