// Toolbar popup (wiki/plan.md §3 M3): the fast per-site controls. The design
// handoff's popup pattern: one 320px card — wordmark, site header (domain +
// status dot + pause), then this DOMAIN's remixlets grouped by whether their
// match patterns include the current page ("Used on this page" / "Others"),
// each with an enable/disable toggle, and the two CTAs. Every mutation goes
// through the worker protocol with reloadTabId set — a toggle is visible on
// the page immediately, which is the same freshness rule the pipeline's
// one-tab reload follows (css.ts).
//
// Harness note: `?tabId=N` pins the target tab, because a popup opened as a
// normal page IS the active tab and would otherwise inspect itself.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MessageCircle, Pause, Play, SlidersHorizontal } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import { ext } from "../platform/ext.js";
import { resolveActiveBrowserTab, type ActiveBrowserTab } from "../platform/active-tab.js";
import type { PlatformCapabilities } from "../platform/capabilities.js";
import { panelSurface } from "../platform/panel-surface.js";
import type { PanelToWorker, WorkerToPanel } from "../shared/protocol.js";
import { siteKeyForUrl, siteKeysPausing, urlMatchesAny, urlPaused, urlWithinSiteKey } from "../shared/site-key.js";
import { isWorkerSkewError, requireWorkerReply } from "../shared/worker-reply.js";
import type { RegistryEntry } from "../store/remixlet-store.js";
import type { MenuCommandSummary } from "../worker/menu.js";
import { RemixletLogo } from "./logo.js";
import { readSetupReadiness } from "./onboarding/readiness.js";
import { followThemePreference } from "./theme.js";

async function send<K extends WorkerToPanel["kind"]>(
  message: PanelToWorker,
  expect: K,
): Promise<Extract<WorkerToPanel, { kind: K }>> {
  const reply = requireWorkerReply(message.kind, await ext.runtime.sendMessage(message));
  if (reply.kind === "remixlet.error") throw new Error(reply.message);
  if (reply.kind !== expect) throw new Error(`unexpected worker reply ${reply.kind}`);
  // SAFETY: requireWorkerReply validates the worker envelope and the branch above matches its discriminant.
  return reply as Extract<WorkerToPanel, { kind: K }>;
}

type TargetTab = ActiveBrowserTab;

async function resolveTargetTab(): Promise<TargetTab | undefined> {
  const override = new URLSearchParams(location.search).get("tabId");
  if (override !== null) {
    const tab = await ext.tabs.get(Number(override)).catch(() => undefined);
    return tab?.id !== undefined && tab.url ? { id: tab.id, url: tab.url, windowId: tab.windowId } : undefined;
  }
  return resolveActiveBrowserTab();
}

/** The design's rule-line group label: uppercase micro-label, then a hairline
    filling the rest of the row. The only "divider" the card has. */
function GroupLabel({ className, children }: { className?: string; children: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span className="flex-none text-[10px] font-semibold tracking-[0.14em] uppercase whitespace-nowrap text-muted-foreground">
        {children}
      </span>
      <div aria-hidden className="h-px flex-1 bg-[var(--line-soft)]" />
    </div>
  );
}

/** The card header: the shared wordmark, verbatim from the welcome page —
    the mark at 18px next to the name — not a text-only label. */
function PopupHeader() {
  return (
    <header className="flex items-center gap-2">
      <RemixletLogo className="size-[18px]" />
      <h1 className="text-base font-semibold tracking-[-0.01em]">Remixlet</h1>
    </header>
  );
}

/** A command mirrors the remixlet rows: label as plain text, and an explicit
    Run button in the card's outline vocabulary — the label alone read as
    static copy, not something clickable. A label longer than the row keeps
    one line and marquees on hover: at rest it clips under a right-edge fade,
    and hovering the row slides the text left just far enough to show the end,
    sliding back on leave. The harness targets the row (.menu-command, data-*),
    reads .menu-command-label, and clicks .menu-command-run. */
function CommandRow({
  command,
  disabled,
  onRun,
}: {
  command: MenuCommandSummary;
  disabled: boolean;
  onRun: () => void;
}) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);
  const [shift, setShift] = useState(0);
  useEffect(() => {
    const el = labelRef.current;
    if (el) setOverflow(Math.max(0, el.scrollWidth - el.clientWidth));
  }, [command.label]);
  // The fade edge is the "there's more" affordance (text-overflow's ellipsis
  // can't render across a translated child): at rest the tail fades out, and
  // once scrolled the fade swaps to the head the text slid away from.
  const fade =
    overflow > 0
      ? shift > 0
        ? "linear-gradient(to right, transparent, black 14px)"
        : "linear-gradient(to left, transparent, black 14px)"
      : undefined;
  return (
    <div
      className="menu-command flex items-center justify-between gap-2"
      data-remixlet-id={command.remixletId}
      data-command-id={command.commandId}
      onMouseEnter={() => setShift(overflow)}
      onMouseLeave={() => setShift(0)}
    >
      <span
        ref={labelRef}
        className="menu-command-label min-w-0 flex-1 overflow-hidden text-sm leading-5 whitespace-nowrap"
        style={{ maskImage: fade, WebkitMaskImage: fade }}
      >
        <span
          className="inline-block transition-transform motion-reduce:transition-none"
          style={{
            transform: `translateX(${-shift}px)`,
            // Read-out pace, not a fixed duration: long overflows take
            // proportionally longer. The return trip is a quick reset.
            transitionDuration: shift > 0 ? `${Math.max(600, overflow * 20)}ms` : "300ms",
            transitionDelay: shift > 0 ? "250ms" : "0ms",
            transitionTimingFunction: shift > 0 ? "linear" : "ease-out",
          }}
        >
          {command.label}
        </span>
      </span>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="menu-command-run bg-transparent dark:bg-transparent"
        disabled={disabled}
        onClick={onRun}
      >
        <Play className="size-3" />
        Run
      </Button>
    </div>
  );
}

function PopupApp() {
  const [tab, setTab] = useState<TargetTab | undefined>(undefined);
  const [targetStatus, setTargetStatus] = useState<"loading" | "resolved" | "not-found">("loading");
  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [commands, setCommands] = useState<MenuCommandSummary[]>([]);
  const [pausedKeys, setPausedKeys] = useState<string[]>([]);
  const [capabilities, setCapabilities] = useState<PlatformCapabilities | null>(null);
  const [surfaceError, setSurfaceError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [skewed, setSkewed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  // null = readiness not answered yet; the popup holds its content until then
  // so an unfinished install never flashes the full card before the gate.
  const [setupIncomplete, setSetupIncomplete] = useState<boolean | null>(null);

  async function refresh(target?: TargetTab): Promise<void> {
    const menuTarget = target ?? tab;
    const [listed, paused, caps, menu] = await Promise.all([
      send({ kind: "remixlet.list" }, "remixlet.listed"),
      send({ kind: "site.pausedList" }, "site.pausedState"),
      send({ kind: "capabilities.get" }, "capabilities.result"),
      menuTarget
        ? send({ kind: "menu.list", tabId: menuTarget.id }, "menu.listed")
        : Promise.resolve({ kind: "menu.listed" as const, commands: [] }),
    ]);
    setEntries(listed.entries);
    setPausedKeys(paused.pausedSiteKeys);
    setCapabilities(caps.capabilities);
    setCommands(menu.commands);
    if (target) setTab(target);
    setLoaded(true);
  }

  useEffect(() => {
    void resolveTargetTab()
      .catch((cause: unknown) => {
        console.error("[remixlet] active page resolution failed", cause);
        return undefined;
      })
      .then((target) => {
        setTargetStatus(target ? "resolved" : "not-found");
        // Land the tab NOW: the site header must never wait on the worker
        // round-trips below. Before this, a slow refresh flashed — and a
        // failed refresh permanently showed — the "couldn't identify the
        // active web page" message with the page sitting right there.
        if (target) setTab(target);
        return refresh(target);
      })
      .catch((cause: unknown) => {
        console.error("[remixlet] popup refresh failed", cause);
        // Build skew ("the worker answered from a different build") gets the
        // plain-words recovery card with a reload action; the diagnostic text
        // stays in the console line above. Everything else shows its reason.
        if (isWorkerSkewError(cause)) setSkewed(true);
        else setRefreshError(cause instanceof Error ? cause.message : String(cause));
      });
  }, []);

  // Onboarding gate: the SAME readiness the manager redirects on (scripts lane
  // AND a usable provider) — not just the user-scripts capability. Gating on
  // capabilities alone let the popup claim setup was done (scripts granted, no
  // provider yet) while every other surface still sent people to welcome.html.
  // Mirrors manager.tsx: a failed check counts as incomplete.
  useEffect(() => {
    void readSetupReadiness()
      .then((readiness) => setSetupIncomplete(!readiness.complete))
      .catch((cause: unknown) => {
        console.error("[remixlet] setup readiness check failed", cause);
        setSetupIncomplete(true);
      });
  }, []);

  const siteKey = tab ? siteKeyForUrl(tab.url) : "";
  const isHttp = tab !== undefined && /^https?:/.test(tab.url);
  const onThisPage = (entry: RegistryEntry): boolean => isHttp && urlMatchesAny(tab.url, entry.matches);
  // Domain scope, not page scope: a remixlet whose matches are path-scoped (or
  // point at other pages of this site) still belongs here and stays togglable.
  // Whether it runs on THIS page picks its group — "Used on this page" is what
  // actually targets this URL, "Others" is the rest of the domain's remixlets.
  const onSite = isHttp
    ? entries.filter((e) => e.state !== "archived" && urlWithinSiteKey(tab.url, e.siteKey))
    : [];
  const hereItems = onSite.filter(onThisPage);
  const otherItems = onSite.filter((e) => !onThisPage(e));
  const paused = isHttp && urlPaused(tab.url, pausedKeys);
  // A pause owns the whole remixlet, so a row here can be stopped by a pause
  // authored on one of its OTHER hosts while this site itself runs. The
  // redesigned row carries no status line, so the fact lives in the row's
  // title (and data-paused for the harness) — otherwise a dead remixlet
  // looks merely switched off.
  const pausedBy = (entry: RegistryEntry): string[] => siteKeysPausing(entry.siteKey, pausedKeys);
  const rowPaused = (entry: RegistryEntry): boolean => paused || pausedBy(entry).length > 0;

  function guard(action: () => Promise<void>): void {
    if (busy) return;
    setBusy(true);
    void action()
      .catch((cause: unknown) => console.error("[remixlet] popup action failed", cause))
      .then(() => refresh())
      .finally(() => setBusy(false));
  }

  function toggleRemixlet(entry: RegistryEntry, enabled: boolean): void {
    guard(async () => {
      await send(
        {
          kind: "remixlet.setEnabled",
          id: entry.id,
          enabled,
          reloadTabId: tab?.id,
        },
        "remixlet.entry",
      );
    });
  }

  function togglePause(nextPaused: boolean): void {
    guard(async () => {
      await send(
        {
          kind: "site.setPaused",
          siteKey,
          paused: nextPaused,
          reloadTabId: tab?.id,
          // Pause is a kill switch: reload every affected tab, not just this
          // one, so injected code stops running everywhere it was live (and a
          // resume brings it back on those same tabs).
          reloadMatching: true,
        },
        "site.pausedState",
      );
    });
  }

  function invokeCommand(command: MenuCommandSummary): void {
    if (!tab) return;
    guard(async () => {
      const reply = await send(
        {
          kind: "menu.invoke",
          tabId: tab.id,
          registrationId: command.registrationId,
        },
        "menu.invoked",
      );
      if (!reply.queued) throw new Error("menu command is no longer available");
    });
  }

  function openChat(): void {
    setSurfaceError("");
    void panelSurface()
      .open(tab?.windowId, tab?.id)
      .then(() => window.close())
      .catch((cause: unknown) => setSurfaceError(`The panel could not open: ${String(cause)}`));
  }

  function openManager(): void {
    void ext.tabs.create({ url: ext.runtime.getURL("manager.html") }).then(() => window.close());
  }

  function openOnboarding(): void {
    void ext.tabs.create({ url: ext.runtime.getURL("welcome.html") }).then(() => window.close());
  }

  // The header line sits under the DOMAIN, so it counts the domain: every
  // remixlet listed on this card that is switched on and not silenced by a
  // pause from any of its hosts — not just the ones matching this exact URL.
  // Page scope belongs to the "Used on this page" group, not to this line.
  const enabledCount = onSite.filter((e) => e.state === "enabled" && !rowPaused(e)).length;
  // "Nothing runs here" has to mean it, on the same domain scope: the site
  // pause covers everything, and so does a domain whose every remixlet is
  // paused from somewhere else.
  const nothingRunsHere = paused || (onSite.length > 0 && onSite.every(rowPaused));

  // Until setup is complete the extension can't do its job, so the popup shows
  // nothing but the way forward. "unsupported" browsers have no scripts toggle
  // to flip (readiness treats that step as settled), so they only land here
  // while a provider is missing; once set up they keep the full popup with the
  // informational alert below.
  if (setupIncomplete !== false) {
    if (setupIncomplete === null) {
      return (
        <div className="w-[23rem] p-6">
          <div className="flex flex-col gap-4.5 rounded-xl bg-card p-4 shadow-[var(--ring-soft),var(--ring-1)]">
            <PopupHeader />
          </div>
        </div>
      );
    }
    return (
      <div className="w-[23rem] p-6">
        <div
          id="popup-onboarding"
          className="flex flex-col gap-4.5 rounded-xl bg-card p-4 shadow-[var(--ring-soft),var(--ring-1)]"
        >
          <PopupHeader />
          <p className="text-sm text-muted-foreground">Remixlet isn’t set up yet. Finish setup to start remixing pages.</p>
          <Button id="finish-setup" type="button" className="rounded-md px-3 text-[13px]" onClick={openOnboarding}>
            Finish setup
          </Button>
        </div>
      </div>
    );
  }

  const row = (entry: RegistryEntry, dimmed = false): ReactNode => {
    const elsewhere = paused ? [] : pausedBy(entry);
    const isPaused = rowPaused(entry);
    const onPage = onThisPage(entry);
    // System-parked after a failed verification: the toggle is unusable — the
    // remixlet is known broken, so flipping it on makes no sense and flipping
    // it "off" is a no-op (it already doesn't run). The label is the
    // explanation; fixing it in chat (or archiving it) is the way out.
    const needsAttention = entry.state === "needs-attention";
    return (
      <div
        key={entry.id}
        className={cn("remixlet-row flex items-center justify-between gap-2", dimmed && "opacity-60")}
        data-id={entry.id}
        data-paused={isPaused ? "true" : undefined}
        data-on-page={onPage ? "true" : undefined}
        title={
          needsAttention
            ? "The last change to this remixlet couldn't be confirmed working, so it's off the page until it's fixed."
            : elsewhere.length > 0
              ? `Paused on ${elsewhere.join(", ")}`
              : undefined
        }
      >
        <span className="min-w-0 truncate text-sm leading-5">{entry.name}</span>
        {needsAttention ? (
          <span className="remixlet-needs-attention shrink-0 text-xs font-medium text-[var(--signal)]">
            Needs attention
          </span>
        ) : (
          /* The toggle stays live outside a site pause — enable/disable is the
             remixlet's own switch, independent of which pages it matches. */
          <Switch
            className="remixlet-toggle"
            checked={entry.state === "enabled"}
            disabled={busy}
            onCheckedChange={(checked) => toggleRemixlet(entry, checked)}
          />
        )}
      </div>
    );
  };

  return (
    // The popup window is a square Chrome owns — no API rounds or clears it.
    // So the window is the canvas backdrop and everything lives on one
    // rounded 320px card, exactly the design file's composition.
    <div className="w-[23rem] p-6">
      <div className="flex flex-col gap-4.5 rounded-xl bg-card p-4 shadow-[var(--ring-soft),var(--ring-1)]">
        <PopupHeader />

        {capabilities && !capabilities.userScripts && (
          <Alert variant="default" id="popup-userscripts-alert">
            <AlertTitle>JavaScript remixlets aren’t available</AlertTitle>
            <AlertDescription>
              {capabilities.disabledReasons.userScripts ?? capabilities.userScriptsDisabledReason}
            </AlertDescription>
            <AlertAction>
              <Button type="button" variant="outline" size="sm" onClick={openOnboarding}>
                Learn more
              </Button>
            </AlertAction>
          </Alert>
        )}

        {surfaceError && (
          <Alert variant="destructive" id="popup-panel-error">
            <AlertTitle>Panel unavailable</AlertTitle>
            <AlertDescription>{surfaceError}</AlertDescription>
          </Alert>
        )}

        {skewed && (
          <Alert id="popup-skew">
            <AlertTitle>Remixlet was updated</AlertTitle>
            <AlertDescription>
              This popup is newer than the part still running in the background. Reload to finish the update.
            </AlertDescription>
            <AlertAction>
              <Button type="button" variant="outline" size="sm" onClick={() => ext.runtime.reload()}>
                Reload
              </Button>
            </AlertAction>
          </Alert>
        )}

        {refreshError && (
          <Alert variant="destructive" id="popup-refresh-error">
            <AlertTitle>Couldn’t load this site’s remixlets</AlertTitle>
            <AlertDescription>{refreshError}</AlertDescription>
          </Alert>
        )}

        {targetStatus === "loading" ? (
          <p className="text-sm text-muted-foreground">Finding the active page…</p>
        ) : isHttp ? (
          <>
            {/* Site header: the domain is the scope and the pause is a labeled
              verb button (Pause/Resume) rather than a switch, so on-means-off
              can't happen. The button stays visible on a paused-but-empty
              site — the popup is the only surface that can unpause it. */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-col gap-px">
                <span id="site-key" className="truncate text-[15px] leading-5 font-semibold tracking-[-0.01em]">
                  {siteKey}
                </span>
                {loaded && (
                  <span className="flex items-center gap-[5px] text-xs leading-4 text-muted-foreground">
                    {nothingRunsHere ? (
                      <>
                        <span aria-hidden className="size-1.5 flex-none rounded-full bg-[var(--signal)]" />
                        Paused — nothing runs here
                      </>
                    ) : onSite.length === 0 ? (
                      <span id="popup-empty">No remixlets yet, open the chat to start.</span>
                    ) : (
                      <>
                        <span aria-hidden className="size-1.5 flex-none rounded-full bg-primary" />
                        {enabledCount === 1 ? "1 remixlet active" : `${enabledCount} remixlets active`}
                      </>
                    )}
                  </span>
                )}
              </div>
              {loaded && (paused || onSite.length > 0) && (
                <Button
                  id="site-pause"
                  type="button"
                  variant={paused ? "default" : "outline"}
                  size="sm"
                  className={cn("gap-1.5 text-xs", !paused && "bg-transparent dark:bg-transparent")}
                  disabled={busy}
                  onClick={() => togglePause(!paused)}
                >
                  {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
                  {paused ? "Resume" : "Pause"}
                </Button>
              )}
            </div>

            {onSite.length > 0 && (
              // The pause dims the LIST, not the rows: 45% with the design's
              // 150ms fade, and inert so the toggles are no-ops while nothing
              // can run anyway. "Others" rows sit at 60% on top of that.
              <div
                inert={paused || undefined}
                className={cn("flex flex-col gap-2.5 transition-opacity duration-150", paused && "opacity-45")}
              >
                {hereItems.length > 0 && (
                  <>
                    <GroupLabel>Used on this page</GroupLabel>
                    {hereItems.map((entry) => row(entry))}
                  </>
                )}
                {otherItems.length > 0 && (
                  <>
                    {/* "Others" only reads as "others" next to the page group.
                        Alone on the card it has nothing to be other than, so
                        it says what it is instead. */}
                    <GroupLabel className={hereItems.length > 0 ? "mt-2" : undefined}>
                      {hereItems.length > 0 ? "Others" : "Not used on this page"}
                    </GroupLabel>
                    {otherItems.map((entry) => row(entry, true))}
                  </>
                )}
              </div>
            )}

            {commands.length > 0 && (
              <div id="menu-commands" className="flex flex-col gap-1.5">
                <GroupLabel className="mb-1">Commands</GroupLabel>
                {commands.map((command) => (
                  <CommandRow
                    key={command.registrationId}
                    command={command}
                    disabled={busy || paused}
                    onRun={() => invokeCommand(command)}
                  />
                ))}
              </div>
            )}
          </>
        ) : tab ? (
          <p className="text-sm text-muted-foreground">Remixlets only run on regular web pages.</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Remixlet couldn’t identify the active web page. Return to the page and try again.
          </p>
        )}

        <div className="flex gap-2">
          <Button
            id="open-chat"
            type="button"
            className="flex-1 rounded-md px-3 text-[13px]"
            onClick={openChat}
            disabled={!isHttp}
          >
            <MessageCircle className="size-3.5" />
            Open chat
          </Button>
          <Button
            id="open-manager"
            type="button"
            variant="outline"
            className="flex-1 rounded-md bg-transparent px-3 text-[13px] dark:bg-transparent"
            onClick={openManager}
          >
            <SlidersHorizontal className="size-3.5" />
            Manage
          </Button>
        </div>
      </div>
    </div>
  );
}

followThemePreference();
createRoot(document.getElementById("root")!).render(<PopupApp />);
