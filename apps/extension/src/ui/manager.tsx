// Control center (wiki/plan.md §3 M3): the single full-page surface. A left
// sidebar (logo, Chats/Settings, then every remixlet grouped per domain)
// drives a hash-routed right panel: overview, settings (with providers), and one full
// page per remixlet — the trust surface, centered on that remixlet's
// committed source. Mutations use reloadMatching so changes are LIVE in every
// open tab the remixlet covers.
//
// Setup is a gate in front of all of it. Readiness is computed from facts on
// load (ui/onboarding/readiness.ts) — never a "has seen onboarding" flag — so
// a revoked user-scripts toggle or a deleted last provider closes this
// surface again. Unfinished setup never renders the sidebar at all: the
// document redirects to the standalone welcome page instead.

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import type { PlatformCapabilities } from "../platform/capabilities.js";
import type { RegistryEntry } from "../store/remixlet-store.js";
import { ConversationLogPage } from "./control-center/conversation-log-page.js";
import { ConversationsPage } from "./control-center/conversations-page.js";
import { DashboardPage } from "./control-center/dashboard-page.js";
import { RemixletPage } from "./control-center/remixlet-page.js";
import { SettingsPage } from "./control-center/settings-page.js";
import { useRoute } from "./control-center/router.js";
import { send } from "./control-center/send.js";
import { Shell } from "./control-center/shell.js";
import { readSetupReadiness, welcomeUrl } from "./onboarding/readiness.js";
import { followThemePreference } from "./theme.js";

function PlatformLimitations({ capabilities }: { capabilities: PlatformCapabilities | null }) {
  if (!capabilities || capabilities.target === "chrome") return null;
  const reasons = [...new Set(Object.values(capabilities.disabledReasons))].filter(
    (reason): reason is string => reason !== undefined && reason.length > 0,
  );
  if (reasons.length === 0) return null;
  const browserName = capabilities.target === "safari" ? "Safari" : "Firefox";
  return (
    <Alert id="manager-platform-limitations" data-target={capabilities.target}>
      <AlertTitle>{browserName} limited mode</AlertTitle>
      <AlertDescription>
        <p>Remixlet adapts to this browser and disables features it cannot support safely.</p>
        <details className="mt-1">
          <summary className="cursor-pointer font-medium">Why some features are unavailable</summary>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </details>
      </AlertDescription>
    </Alert>
  );
}

function ControlCenterApp() {
  const route = useRoute();
  const [entries, setEntries] = useState<RegistryEntry[] | undefined>(undefined);
  const [pausedKeys, setPausedKeys] = useState<string[]>([]);
  const [siteIcons, setSiteIcons] = useState<Record<string, string> | undefined>(undefined);
  const [capabilities, setCapabilities] = useState<PlatformCapabilities | null>(null);

  async function refresh(): Promise<void> {
    const [listed, paused, icons, caps] = await Promise.all([
      send({ kind: "remixlet.list" }, "remixlet.listed"),
      send({ kind: "site.pausedList" }, "site.pausedState"),
      send({ kind: "siteIcon.list" }, "siteIcon.listed"),
      send({ kind: "capabilities.get" }, "capabilities.result"),
    ]);
    setEntries(listed.entries);
    setPausedKeys(paused.pausedSiteKeys);
    setSiteIcons(icons.icons);
    setCapabilities(caps.capabilities);
  }

  // Refetch on every navigation, not just mount: remixlets are created and
  // mutated outside this document (panel agent, popup toggles), and the store
  // is git-in-OPFS — there is no storage event to subscribe to.
  useEffect(() => {
    void refresh();
  }, [route]);

  let content;
  switch (route.kind) {
    case "settings":
      content = <SettingsPage section={route.section} />;
      break;
    case "conversations":
      content = <ConversationsPage siteIcons={siteIcons} />;
      break;
    case "conversation":
      content = <ConversationLogPage key={route.id} id={route.id} />;
      break;
    case "remixlet": {
      const entry = entries?.find((candidate) => candidate.id === route.id);
      content = entry ? (
        <RemixletPage key={entry.id} entry={entry} siteIcons={siteIcons} onChanged={refresh} />
      ) : entries === undefined ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <p id="remixlet-not-found" className="text-sm text-muted-foreground">
          No remixlet named “{route.id}” — it may have been deleted.
        </p>
      );
      break;
    }
    default:
      content = <DashboardPage entries={entries} siteIcons={siteIcons} />;
  }

  return (
    <Shell
      route={route}
      entries={entries}
      pausedKeys={pausedKeys}
      siteIcons={siteIcons}
      fill={route.kind === "remixlet"}
      onChanged={refresh}
    >
      <PlatformLimitations capabilities={capabilities} />
      {content}
    </Shell>
  );
}

/**
 * The gate. Nothing of the control center mounts — no sidebar, no worker
 * round-trips — until setup is known to be finished; an unfinished install
 * replaces this document with the welcome page, so there is no back-button
 * crack to slip through either.
 *
 * And it keeps watch: the control center is a hash-routed SPA in ONE
 * document, so mount is the only free re-check — a tab that outlives the
 * "Allow user scripts" grant would otherwise stay open forever on an install
 * that no longer works. Every route change re-asks (readiness verifies with
 * a real API call, which is what catches a revoked grant in a context that
 * still holds the namespace) and diverts to setup the moment the answer
 * turns false.
 */
function ControlCenterRoot() {
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = (): void => {
      void readSetupReadiness()
        .then((readiness) => {
          if (cancelled) return;
          if (readiness.complete) setAllowed(true);
          else location.replace(welcomeUrl());
        })
        .catch((cause: unknown) => {
          // Storage unreadable is not a reason to hand out an unusable
          // control center; setup is the safe place to land.
          console.error("[remixlet] setup readiness check failed", cause);
          if (!cancelled) location.replace(welcomeUrl());
        });
    };
    check();
    window.addEventListener("hashchange", check);
    return () => {
      cancelled = true;
      window.removeEventListener("hashchange", check);
    };
  }, []);

  // Deliberately blank while deciding: a flash of sidebar before the redirect
  // would be exactly the surface the gate exists to withhold.
  return allowed ? <ControlCenterApp /> : null;
}

followThemePreference();
createRoot(document.getElementById("root")!).render(<ControlCenterRoot />);
