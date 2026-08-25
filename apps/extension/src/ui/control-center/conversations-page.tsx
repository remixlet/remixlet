// Chats index: every conversation from the sidecar index, newest first,
// grouped by day, each linking to its run log (#/conversations/<id>) — the
// behind-the-scenes record of what the agent actually did in that chat. A
// domain combobox narrows the list to one site; options come from the
// conversations themselves, so the filter never offers an empty result.

import { useEffect, useMemo, useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";

import type { ConversationMeta } from "../../store/conversation-index.js";
import { SiteIcon } from "../site-icon.js";
import { groupByDay, timeFormat } from "./day-groups.js";
import { routeHash } from "./router.js";
import { send } from "./send.js";

function ConversationRow({ meta, siteIcons }: { meta: ConversationMeta; siteIcons: Record<string, string> | undefined }) {
  return (
    <a
      href={routeHash({ kind: "conversation", id: meta.id })}
      className="conversation-link group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/50"
      data-id={meta.id}
    >
      {meta.siteKey && (
        <span className="flex w-44 shrink-0 items-center gap-1.5 font-mono text-xs text-muted-foreground">
          <SiteIcon icons={siteIcons} siteKey={meta.siteKey} className="size-3.5" />
          <span className="truncate">{meta.siteKey}</span>
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-sm group-hover:text-foreground">
        {meta.title || "Untitled conversation"}
      </span>
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {timeFormat.format(meta.updatedAt)}
      </span>
    </a>
  );
}

export function ConversationsPage({ siteIcons }: { siteIcons: Record<string, string> | undefined }) {
  const [conversations, setConversations] = useState<ConversationMeta[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [domain, setDomain] = useState<string | null>(null);

  useEffect(() => {
    void send({ kind: "conversation.list" }, "conversation.listed")
      .then((reply) => setConversations(reply.conversations))
      .catch((cause: unknown) => setError(String(cause)));
  }, []);

  const domains = useMemo(
    () => [...new Set((conversations ?? []).map((meta) => meta.siteKey).filter(Boolean))].sort(),
    [conversations],
  );
  const filtered = domain ? (conversations ?? []).filter((meta) => meta.siteKey === domain) : (conversations ?? []);
  const groups = groupByDay(filtered, (meta) => meta.updatedAt, new Date());

  return (
    <div id="conversations-page" className="flex flex-col gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Chats</h1>
        {domains.length > 0 && (
          <div id="conversations-domain-filter" className="shrink-0">
            <Combobox
              items={domains}
              value={domain}
              // SAFETY: this combobox's items are strings and its clear action emits null.
              onValueChange={(value) => setDomain(value as string | null)}
            >
              <ComboboxInput placeholder="All sites" showClear className="w-56" aria-label="Filter chats by site" />
              <ComboboxContent>
                <ComboboxEmpty>No site matches.</ComboboxEmpty>
                <ComboboxList>
                  {(item: string) => (
                    <ComboboxItem key={item} value={item}>
                      <SiteIcon icons={siteIcons} siteKey={item} className="size-3.5" />
                      <span className="font-mono text-xs">{item}</span>
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </div>
        )}
      </header>

      {error !== undefined && <p className="text-xs text-destructive">Couldn’t load chats: {error}</p>}
      {conversations === undefined && error === undefined && <p className="text-sm text-muted-foreground">Loading…</p>}
      {conversations?.length === 0 && (
        <p id="conversations-empty" className="text-sm text-muted-foreground">
          No chats yet — open the panel on any page and describe a change.
        </p>
      )}
      {conversations !== undefined && conversations.length > 0 && filtered.length === 0 && (
        <p id="conversations-filter-empty" className="text-sm text-muted-foreground">
          No chats on {domain} yet.
        </p>
      )}

      {groups.map((group) => (
        <section key={group.label} className="flex flex-col gap-2">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{group.label}</h2>
          <Card className="py-0">
            <CardContent className="flex flex-col divide-y px-0">
              {group.items.map((meta) => (
                <ConversationRow key={meta.id} meta={meta} siteIcons={siteIcons} />
              ))}
            </CardContent>
          </Card>
        </section>
      ))}
    </div>
  );
}
