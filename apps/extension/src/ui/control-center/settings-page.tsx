// Settings page: one surface for everything configurable, split into two
// hash-routed sections — General (appearance + chat behavior, backed by the
// chatPreferences key in extension-local storage) and Providers (the model
// provider catalog, its own module in providers-page.tsx). The section tabs
// are plain anchors over the hash router, same as the sidebar, so both
// sections stay deep-linkable (#/settings, #/settings/providers) and only the
// active section mounts — the providers catalog fetch never runs while the
// general tab is open.
//
// Preference changes apply live everywhere: pages re-theme through
// followThemePreference()'s storage listener, the panel rebuilds its
// runtime on the next turn when the verbosity changes, and the permission
// alert switch is read at the next ask (panel/ask-notifications.ts).

import { useEffect, useState } from "react";
import { Bell, BellOff, Loader2, Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { ext } from "../../platform/ext.js";
import {
  CHAT_PREFERENCES_KEY,
  normalizeChatPreferences,
  type ChatPreferences,
  type ChatVerbosity,
  type ThemePreference,
} from "../../shared/chat-preferences.js";
import { ProvidersPage } from "./providers-page.js";
import { navigate, type SettingsSection } from "./router.js";

type Choice<Value extends string> = { value: Value; label: string; detail: string; icon?: LucideIcon };

const THEME_CHOICES: Choice<ThemePreference>[] = [
  { value: "system", label: "System", detail: "Light or dark, following your browser setting.", icon: Monitor },
  { value: "light", label: "Light", detail: "Always light.", icon: Sun },
  { value: "dark", label: "Dark", detail: "Always dark.", icon: Moon },
];

const VERBOSITY_CHOICES: Choice<ChatVerbosity>[] = [
  { value: "quiet", label: "Quiet", detail: "Questions and results only." },
  { value: "standard", label: "Standard", detail: "A short line about each step as it works." },
  { value: "detailed", label: "Detailed", detail: "Standard, plus the model's own working notes." },
];

const ASK_NOTIFICATION_CHOICES: Choice<"on" | "off">[] = [
  { value: "on", label: "On", detail: "A notification when the chat is waiting for your answer and is not in view.", icon: Bell },
  { value: "off", label: "Off", detail: "No notifications. The chat waits without alerting you.", icon: BellOff },
];

const SECTION_TABS: { section: SettingsSection; label: string }[] = [
  { section: "general", label: "General" },
  { section: "providers", label: "Providers" },
];

/**
 * One choice among a few, rendered as a segmented control (same shape as the
 * popup's running/paused switcher). Semantically a radio group; the caption
 * below always restates what the current pick means, so the short segment
 * labels never have to carry the explanation.
 */
function SegmentedChoice<Value extends string>({
  legend,
  choices,
  value,
  onChange,
}: {
  legend: string;
  choices: Choice<Value>[];
  value: Value;
  onChange: (value: Value) => void;
}) {
  const selected = choices.find((choice) => choice.value === value);
  return (
    <div className="flex flex-col gap-1.5 sm:items-end">
      <div role="radiogroup" aria-label={legend} className="flex w-fit rounded-lg bg-muted p-[3px]">
        {choices.map((choice) => {
          const Icon = choice.icon;
          const active = choice.value === value;
          return (
            <button
              key={choice.value}
              type="button"
              role="radio"
              aria-checked={active}
              data-choice={choice.value}
              onClick={() => onChange(choice.value)}
              className={cn(
                "inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors",
                "focus-visible:outline-1 focus-visible:outline-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
                active
                  ? "bg-background text-foreground shadow-sm dark:border dark:border-input dark:bg-input/30"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {Icon && <Icon className="size-3.5 shrink-0" aria-hidden />}
              {choice.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground sm:text-right">{selected?.detail}</p>
    </div>
  );
}

/** Label and explanation on the left, the control on the right; stacks on narrow viewports. */
function SettingRow({
  id,
  title,
  detail,
  children,
}: {
  id: string;
  title: string;
  detail?: string;
  children: React.ReactNode;
}) {
  return (
    <div id={id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
      <div className="flex flex-col gap-0.5 sm:max-w-sm">
        <h2 className="text-sm font-medium">{title}</h2>
        {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
      </div>
      {children}
    </div>
  );
}

function GeneralSection() {
  const [preferences, setPreferences] = useState<ChatPreferences | undefined>(undefined);

  useEffect(() => {
    void ext.storage.local
      .get(CHAT_PREFERENCES_KEY)
      .then((stored) => setPreferences(normalizeChatPreferences(stored[CHAT_PREFERENCES_KEY])));
  }, []);

  function save(next: ChatPreferences): void {
    setPreferences(next);
    void ext.storage.local.set({ [CHAT_PREFERENCES_KEY]: next });
  }

  if (!preferences) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading settings…
      </div>
    );
  }

  return (
    <div id="settings-general" className="flex flex-col gap-5">
      <section className="divide-y rounded-xl border bg-card">
        <SettingRow id="setting-theme" title="Theme" detail="How this app looks visually.">
          <SegmentedChoice
            legend="Theme"
            choices={THEME_CHOICES}
            value={preferences.theme}
            onChange={(theme) => save({ ...preferences, theme })}
          />
        </SettingRow>
        <SettingRow id="setting-verbosity" title="Chat detail" detail="How much the assistant says in chat while it builds.">
          <SegmentedChoice
            legend="Chat detail"
            choices={VERBOSITY_CHOICES}
            value={preferences.verbosity}
            onChange={(verbosity) => save({ ...preferences, verbosity })}
          />
        </SettingRow>
        <SettingRow
          id="setting-ask-notifications"
          title="Permission alerts"
          detail="A system notification when the assistant needs you to allow something and the chat is out of view. If they do not appear, please check your operating system allows notifications from your browser."
        >
          <SegmentedChoice
            legend="Permission alerts"
            choices={ASK_NOTIFICATION_CHOICES}
            value={preferences.askNotifications ? "on" : "off"}
            onChange={(choice) => save({ ...preferences, askNotifications: choice === "on" })}
          />
        </SettingRow>
      </section>
    </div>
  );
}

export function SettingsPage({ section }: { section: SettingsSection }) {
  return (
    <div id="settings-page" className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      </header>

      <Tabs
        value={section}
        onValueChange={(value) => {
          // SAFETY: Tabs only emits values supplied by SECTION_TABS, whose sections are SettingsSection values.
          navigate({ kind: "settings", section: value as SettingsSection });
        }}
      >
        <TabsList aria-label="Settings sections">
          {SECTION_TABS.map((tab) => (
            <TabsTrigger key={tab.section} value={tab.section} id={`settings-tab-${tab.section}`}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {section === "providers" ? <ProvidersPage /> : <GeneralSection />}
    </div>
  );
}
