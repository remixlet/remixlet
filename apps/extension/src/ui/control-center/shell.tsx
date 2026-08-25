// Control-center chrome: a fixed left sidebar (logo, Chats/Settings nav,
// then every remixlet grouped per domain) beside a scrolling content panel.
// Navigation is plain anchors over the hash router, so the whole surface
// stays a single always-live document.

import { ChevronDown, MessagesSquare, Plus, Settings } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

import { openSiteTabWithPanel } from "../../platform/panel-surface.js";
import { RemixletLogo } from "../logo.js";
import { SiteIcon } from "../site-icon.js";
import { siteKeyPaused } from "../../shared/site-key.js";
import type { RegistryEntry } from "../../store/remixlet-store.js";
import { RemixletRowMenu } from "./remixlet-actions.js";
import { routeHash, type Route } from "./router.js";

// No "Status" entry: browser readiness is setup, and setup lives on its own
// page in front of this one (welcome.html). Reaching the sidebar at all means
// it already passed.
const topPages: { route: Route; label: string; icon: typeof Settings }[] = [
  { route: { kind: "conversations" }, label: "Chats", icon: MessagesSquare },
  { route: { kind: "settings", section: "general" }, label: "Settings", icon: Settings },
];

function stateDotClass(state: RegistryEntry["state"]): string {
  if (state === "enabled") return "bg-primary";
  if (state === "archived") return "bg-transparent ring-1 ring-inset ring-muted-foreground/50";
  // System-parked after a failed verification — the provider-list amber.
  if (state === "needs-attention") return "bg-[var(--signal)]";
  return "bg-border";
}

// The highlight and the rounding live on the row, not the anchor, so the ⋯ that
// fades in on hover sits inside the same lit surface. The anchor keeps the link
// semantics and fills the rest of the row.
function SidebarRemixletLink({
  entry,
  active,
  onChanged,
}: {
  entry: RegistryEntry;
  active: boolean;
  onChanged: () => Promise<void>;
}) {
  return (
    <RemixletRowMenu
      entry={entry}
      onChanged={onChanged}
      className={cn(
        "transition-colors",
        active
          ? "rounded-lg bg-[var(--accent-deep)] font-medium text-foreground"
          : "rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <a
        href={routeHash({ kind: "remixlet", id: entry.id })}
        data-nav-remixlet={entry.id}
        data-state={entry.state}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-2 text-[13px]",
          entry.state === "archived" && "italic",
        )}
      >
        {/* The dot sits in a plate-width column so it centers under the group
            header's site-icon chip, and pl-2 mirrors the trigger's px-2. */}
        <span className="flex w-5 shrink-0 items-center justify-center" aria-hidden>
          <span className={cn("size-1.5 rounded-full", stateDotClass(entry.state))} />
        </span>
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      </a>
    </RemixletRowMenu>
  );
}

function SidebarSiteGroup({
  siteKey,
  siteIcons,
  entries,
  paused,
  activeId,
  onChanged,
}: {
  siteKey: string;
  siteIcons: Record<string, string> | undefined;
  entries: RegistryEntry[];
  paused: boolean;
  activeId: string | undefined;
  onChanged: () => Promise<void>;
}) {
  // Composite keys (a.com+b.com) open their first concrete host; a
  // wildcard-only key has nowhere to go, so it gets no "+".
  const host = siteKey.split("+").find((part) => part.length > 0 && part !== "*");
  return (
    <Collapsible defaultOpen className="sidebar-site" data-site={siteKey}>
      {/* Label first, then the disclosure chevron beside it — the group reads
          as a heading rather than as a tree node; the rows below indent just
          enough that their state dot sits under the icon. The "+" is a sibling of
          the trigger (buttons cannot nest), aligned over the rows' ⋯ column. */}
      <div className="flex items-center pr-1">
        <CollapsibleTrigger className="group/site flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-secondary">
            <SiteIcon icons={siteIcons} siteKey={siteKey} className="size-3" />
          </span>
          <span className="min-w-0 truncate text-left">{siteKey}</span>
          <ChevronDown
            className="size-3.5 shrink-0 -rotate-90 transition-transform group-data-[panel-open]/site:rotate-0"
            aria-hidden
          />
          <span className="flex-1" aria-hidden />
          {paused && (
            <Badge variant="outline" className="site-paused shrink-0 px-1 py-0 text-[10px]">
              paused
            </Badge>
          )}
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70 group-data-[panel-open]/site:hidden">
            {entries.length}
          </span>
        </CollapsibleTrigger>
        {host && (
          <button
            type="button"
            data-action="open-site"
            aria-label={`Open ${host} in a new tab with the Remixlet panel`}
            title={`Open ${host} with the panel`}
            onClick={() => {
              void openSiteTabWithPanel(`https://${host}/`).catch((cause) =>
                console.error("[remixlet] open site tab failed", cause),
              );
            }}
            className={cn(
              buttonVariants({ variant: "ghost", size: "icon-xs" }),
              "shrink-0 text-muted-foreground hover:text-foreground",
            )}
          >
            <Plus aria-hidden />
          </button>
        )}
      </div>
      <CollapsibleContent className="flex flex-col pt-0.5">
        {entries.map((entry) => (
          <SidebarRemixletLink key={entry.id} entry={entry} active={entry.id === activeId} onChanged={onChanged} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function Shell({
  route,
  entries,
  pausedKeys,
  siteIcons,
  fill = false,
  onChanged,
  children,
}: {
  route: Route;
  entries: RegistryEntry[] | undefined;
  pausedKeys: string[];
  /** Snapshotted favicon data URLs by site key (siteIcon.list). */
  siteIcons: Record<string, string> | undefined;
  /** Fill the viewport (full width and height, inner scrolling) instead of a centered scrolling column. */
  fill?: boolean;
  /** Refetch after a sidebar right-click action mutates the registry. */
  onChanged: () => Promise<void>;
  children: ReactNode;
}) {
  const bySite = new Map<string, RegistryEntry[]>();
  for (const entry of entries ?? []) {
    const group = bySite.get(entry.siteKey) ?? [];
    group.push(entry);
    bySite.set(entry.siteKey, group);
  }
  const activeId = route.kind === "remixlet" ? route.id : undefined;
  const enabledCount = entries?.filter((entry) => entry.state === "enabled").length ?? 0;

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 flex h-dvh w-64 shrink-0 flex-col border-r border-[var(--line-soft)] bg-card lg:w-[19.2rem]" aria-label="Remixlet navigation">
        {/* The shared wordmark, same as the popup and welcome page: the mark at 18px next to the name. */}
        <a href={routeHash({ kind: "overview" })} id="nav-overview" className="flex items-center gap-2 px-4 py-4">
          <RemixletLogo className="size-[18px] shrink-0" />
          <span className="text-base font-semibold tracking-[-0.01em]">Remixlet</span>
        </a>

        <nav className="flex flex-col gap-0.5 px-2" aria-label="Remixlet pages">
          {topPages.map((page) => {
            const Icon = page.icon;
            const selected =
              page.route.kind === route.kind || (page.route.kind === "conversations" && route.kind === "conversation");
            return (
              <a
                key={page.route.kind}
                id={`nav-${page.route.kind}`}
                href={routeHash(page.route)}
                aria-current={selected ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] transition-colors",
                  selected
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{page.label}</span>
              </a>
            );
          })}
        </nav>

        <div className="mt-4 flex min-h-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {entries !== undefined && bySite.size === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                None yet — open the panel on any page and describe a change.
              </p>
            )}
            <div className="flex flex-col gap-4">
              {[...bySite.entries()].map(([siteKey, group]) => (
                <SidebarSiteGroup
                  key={siteKey}
                  siteKey={siteKey}
                  siteIcons={siteIcons}
                  entries={group}
                  paused={siteKeyPaused(siteKey, pausedKeys)}
                  activeId={activeId}
                  onChanged={onChanged}
                />
              ))}
            </div>
          </div>
        </div>

        <p id="sidebar-summary" className="border-t px-4 py-3 text-xs text-muted-foreground">
          {entries ? `${enabledCount} enabled · ${entries.length} total` : "Loading…"}
        </p>
      </aside>

      <main className="min-w-0 flex-1">
        {fill ? (
          <div className="flex h-dvh w-full flex-col gap-4 overflow-hidden p-4 sm:p-6">{children}</div>
        ) : (
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 sm:p-6">{children}</div>
        )}
      </main>
    </div>
  );
}
