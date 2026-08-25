// The connected-providers list: one card surface, one row per provider. A row
// click expands an inset panel with the model ids, endpoint, and actions. A
// provider whose most recent attempted use failed (lastError) renders in the
// amber needs-attention state — derived purely from recorded outcomes, never
// from a scheduled check (providers are only contacted during chat or an
// explicit Refresh / Retry here).

import { useState } from "react";
import { ChevronDown, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { PROVIDER_CATALOG } from "../../agent/provider-catalog.js";
import { PROVIDER_DEFAULTS, type ProviderConfig, type ProviderKind } from "../../shared/settings.js";
import { ProviderLogo } from "./provider-logo.js";

// The quiet qualifier after the name says how the provider is accessed — it
// never repeats the name itself.
// SAFETY: PROVIDER_CATALOG contains one entry for every ProviderKind.
const KIND_QUALIFIER: Record<ProviderKind, string> = Object.fromEntries(
  PROVIDER_CATALOG.map((entry) => [entry.kind, entry.qualifier]),
) as Record<ProviderKind, string>;

// "2 min ago" / "yesterday" for the status line; the expanded panel carries
// the precise timestamp instead.
function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}

function hostWithoutScheme(baseUrl: string): string {
  return baseUrl.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
}

function ProviderRow({
  provider,
  busy,
  expanded,
  onToggle,
  onRefresh,
  onUpdate,
  onRemove,
}: {
  provider: ProviderConfig;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onRefresh: () => void;
  onUpdate: (changes: Pick<ProviderConfig, "name" | "baseUrl" | "apiKey">) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [replacementKey, setReplacementKey] = useState("");

  const broken = provider.lastError !== undefined;
  const statusLine = broken
    ? `Endpoint unreachable${provider.lastUsedAt ? ` · last answered ${relativeTime(provider.lastUsedAt)}` : ""}`
    : `${provider.models.length} model${provider.models.length === 1 ? "" : "s"}${
        provider.lastUsedAt ? ` · last used ${relativeTime(provider.lastUsedAt)}` : ""
      }`;
  const meta = `${hostWithoutScheme(provider.baseUrl)}${
    provider.lastUsedAt
      ? ` · last ${broken ? "answered" : "used"} ${new Date(provider.lastUsedAt).toLocaleString(undefined, {
          dateStyle: "short",
          timeStyle: "short",
        })}`
      : ""
  }`;

  return (
    <div data-provider-id={provider.id} className="border-b border-[var(--line-soft)] last:border-b-0">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-foreground/3"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary">
          <ProviderLogo kind={provider.kind} className="size-4.5 text-foreground" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="truncate text-sm font-medium">
            {provider.name} <span className="font-normal text-muted-foreground">· {KIND_QUALIFIER[provider.kind]}</span>
          </span>
          <span
            className={cn(
              "flex items-center gap-1.5 text-xs",
              broken ? "text-[var(--signal)]" : "text-muted-foreground",
            )}
          >
            <span
              className={cn("size-1.5 shrink-0 rounded-full", broken ? "bg-[var(--signal)]" : "bg-primary")}
              aria-hidden
            />
            {statusLine}
          </span>
        </span>
        {broken && <span className="shrink-0 text-xs font-medium text-[var(--signal)]">Needs attention</span>}
        <ChevronDown
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")}
          aria-hidden
        />
      </button>

      {expanded && (
        <div className="mr-4 mb-3.5 ml-16 flex flex-col gap-2.5 rounded-lg bg-background/60 p-3">
          {broken && (
            <p className="text-[12.5px] text-[var(--signal)]">
              The endpoint did not answer when chat last tried it. If the server is running, its address may have
              changed — the model list below is from the last successful request.
            </p>
          )}

          {provider.models.length > 0 ? (
            <div
              className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-x-4 gap-y-1.5 font-mono text-xs"
              aria-label={`Models available from ${provider.name}`}
            >
              {provider.models.map((model) => (
                <span key={model} className="truncate">
                  {model}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No models reported yet.</p>
          )}

          <div className="h-px bg-[var(--line-soft)]" aria-hidden />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground">{meta}</span>
            <span className="flex gap-1.5">
              <Button type="button" variant="outline" size="xs" disabled={busy} onClick={onRefresh}>
                {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {broken ? "Retry now" : "Refresh"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setEditing((value) => !value)}
              >
                Edit
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={busy}
                onClick={onRemove}
              >
                Remove
              </Button>
            </span>
          </div>

          {editing && (
            <FieldGroup className="gap-3 rounded-lg border bg-muted/25 p-3">
              <Field>
                <FieldLabel htmlFor={`provider-name-${provider.id}`}>Display name</FieldLabel>
                <Input id={`provider-name-${provider.id}`} value={name} onChange={(event) => setName(event.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor={`provider-url-${provider.id}`}>Base URL</FieldLabel>
                <Input
                  id={`provider-url-${provider.id}`}
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </Field>
              {provider.kind !== "codex" && (
                <Field>
                  <FieldLabel htmlFor={`provider-key-${provider.id}`}>Replace API key</FieldLabel>
                  <Input
                    id={`provider-key-${provider.id}`}
                    type="password"
                    value={replacementKey}
                    onChange={(event) => setReplacementKey(event.target.value)}
                    placeholder="Leave blank to keep the stored key"
                  />
                </Field>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    onUpdate({
                      name: name.trim() || PROVIDER_DEFAULTS[provider.kind].label,
                      baseUrl: baseUrl.trim(),
                      apiKey: replacementKey.trim() || provider.apiKey,
                    });
                    setReplacementKey("");
                    setEditing(false);
                  }}
                >
                  Save changes
                </Button>
              </div>
            </FieldGroup>
          )}
        </div>
      )}
    </div>
  );
}

export function ProviderList({
  providers,
  busyProviderId,
  onRefresh,
  onUpdate,
  onRemove,
}: {
  providers: ProviderConfig[];
  busyProviderId: string | null;
  onRefresh: (provider: ProviderConfig) => void;
  onUpdate: (provider: ProviderConfig, changes: Pick<ProviderConfig, "name" | "baseUrl" | "apiKey">) => void;
  onRemove: (provider: ProviderConfig) => void;
}) {
  // Multiple rows may be open at once; the set is purely view state.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-foreground/10 bg-card">
      {providers.map((provider) => (
        <ProviderRow
          key={provider.id}
          provider={provider}
          busy={busyProviderId === provider.id}
          expanded={expanded.has(provider.id)}
          onToggle={() => toggle(provider.id)}
          onRefresh={() => onRefresh(provider)}
          onUpdate={(changes) => onUpdate(provider, changes)}
          onRemove={() => onRemove(provider)}
        />
      ))}
    </div>
  );
}
