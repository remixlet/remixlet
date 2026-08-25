// The design system's dark mode is class-based (`.dark` on <html>, the shadcn
// convention). Extension pages can't run inline scripts under MV3 CSP, so
// every page entry calls followThemePreference() before mounting. The stored
// preference (Settings page) wins; "system" — the default — follows the OS
// scheme live. Storage changes re-apply, so an open page flips the moment the
// Settings page saves.

import { ext } from "../platform/ext.js";
import {
  CHAT_PREFERENCES_KEY,
  normalizeChatPreferences,
  type ThemePreference,
} from "../shared/chat-preferences.js";

export function followThemePreference(): void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  let preference: ThemePreference = "system";
  const apply = (): void => {
    const dark = preference === "dark" || (preference === "system" && media.matches);
    document.documentElement.classList.toggle("dark", dark);
  };
  // Follow the OS immediately — the storage read is async, and "system" is
  // both the default and the overwhelmingly common value, so this avoids a
  // wrong-theme flash while it resolves.
  apply();
  media.addEventListener("change", apply);
  void ext.storage.local.get(CHAT_PREFERENCES_KEY).then((stored) => {
    preference = normalizeChatPreferences(stored[CHAT_PREFERENCES_KEY]).theme;
    apply();
  });
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(CHAT_PREFERENCES_KEY in changes)) return;
    // SAFETY: storage.onChanged maps every changed key to a StorageChange value.
    const change = changes[CHAT_PREFERENCES_KEY] as chrome.storage.StorageChange;
    preference = normalizeChatPreferences(change.newValue).theme;
    apply();
  });
}
