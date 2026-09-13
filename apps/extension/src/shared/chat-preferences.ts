// Chat preferences: how the extension looks (theme) and how much the agent
// says while it works (verbosity). Stored under one key in extension-local
// storage; the Settings page writes it, the panel and every page entry read
// it. Pure data + normalization here, storage IO stays with the consumers —
// same split as shared/settings.ts.

export type ThemePreference = "system" | "light" | "dark";

/**
 * How much the agent says in chat while it works:
 * - "quiet"    — questions and results only; no step-by-step narration.
 * - "standard" — a short plain sentence before each batch of steps (default).
 * - "detailed" — standard, plus the model's own working notes (its reasoning
 *   summaries) streamed as muted rows.
 */
export type ChatVerbosity = "quiet" | "standard" | "detailed";

export interface ChatPreferences {
  version: 1;
  theme: ThemePreference;
  verbosity: ChatVerbosity;
  /**
   * Whether the panel raises a system notification when the agent is waiting
   * on a permission answer (an access dialog, a script approval, or a
   * one-click grant card) and the chat is not in view. On by default: an
   * unanswered ask is a stalled build, and the user has usually switched
   * away by then. Off for anyone the toasts annoy (panel/ask-notifications.ts).
   */
  askNotifications: boolean;
}

export const CHAT_PREFERENCES_KEY = "chatPreferences";

export const DEFAULT_CHAT_PREFERENCES: ChatPreferences = {
  version: 1,
  theme: "system",
  verbosity: "standard",
  askNotifications: true,
};

const THEMES: readonly ThemePreference[] = ["system", "light", "dark"];
const VERBOSITIES: readonly ChatVerbosity[] = ["quiet", "standard", "detailed"];

export function normalizeChatPreferences<T>(stored: T): ChatPreferences {
  if (Object.prototype.toString.call(stored) !== "[object Object]") return { ...DEFAULT_CHAT_PREFERENCES };
  const raw = Object(stored);
  const theme = raw.theme;
  const verbosity = raw.verbosity;
  const askNotifications = raw.askNotifications;
  return {
    version: 1,
    theme: isTheme(theme) ? theme : "system",
    verbosity: isChatVerbosity(verbosity) ? verbosity : "standard",
    // Absent in every value written before the field existed: those installs
    // get the default, not a silent off.
    askNotifications: askNotifications === false ? false : true,
  };
}

function isTheme<T>(value: T): value is T & ThemePreference {
  return THEMES.some((theme) => theme === value);
}

function isChatVerbosity<T>(value: T): value is T & ChatVerbosity {
  return VERBOSITIES.some((verbosity) => verbosity === value);
}

/** Only "detailed" surfaces the model's working notes (thinking deltas) in chat. */
export function verbosityShowsWorkingNotes(verbosity: ChatVerbosity): boolean {
  return verbosity === "detailed";
}

/**
 * The ChatGPT-subscription backend takes a response-length hint per request
 * (its default is "low", which reads as near-silence between tool calls).
 * Quiet keeps that default; the talkative levels raise it one notch.
 */
export function codexTextVerbosity(verbosity: ChatVerbosity): "low" | "medium" {
  return verbosity === "quiet" ? "low" : "medium";
}
