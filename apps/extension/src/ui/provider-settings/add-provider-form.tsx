import { useEffect, useRef, useState } from "react";
import { ArrowLeft, BadgeCheck, Check, ChevronDown, KeyRound, Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { PROVIDER_CATALOG, catalogEntry } from "../../agent/provider-catalog.js";
import { PROVIDER_DEFAULTS, type ProviderKind } from "../../shared/settings.js";
import { planIncludesCodex, type CodexAuthStatus } from "../../shared/codex-oauth.js";
import { ProviderLogo } from "./provider-logo.js";

export interface DraftProvider {
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  apiKey: string;
  fallbackModels: string;
}

const newDraft = (kind: ProviderKind = "openai"): DraftProvider => ({
  kind,
  name: PROVIDER_DEFAULTS[kind].label,
  baseUrl: PROVIDER_DEFAULTS[kind].baseUrl,
  apiKey: "",
  fallbackModels: "",
});

type AccessMethod = "subscription" | "api-key";

const ACCESS_OPTIONS: { method: AccessMethod; title: string; description: string }[] = [
  {
    method: "subscription",
    title: "Subscription",
    description: "Sign in with an AI plan you already pay for",
  },
  {
    method: "api-key",
    title: "Bring your own key",
    description: "Use an API key, or point at any OpenAI-compatible endpoint",
  },
];

// The pi-derived catalog decides which providers exist and carries their card
// copy, endpoints, and key-console links; this form only lays them out.
const PROVIDER_OPTIONS = PROVIDER_CATALOG.map(({ kind, access, title, description }) => ({ kind, access, title, description }));

function Step({
  number,
  title,
  hint,
  done,
  last = false,
  children,
}: {
  number: number;
  title: string;
  hint?: string;
  done: boolean;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="relative flex gap-4">
      {!last && <span aria-hidden className="absolute top-8 bottom-0 left-3 w-px bg-border" />}
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
          done ? "border-primary bg-primary text-primary-foreground" : "bg-background text-muted-foreground",
        )}
      >
        {done ? <Check className="size-3.5" /> : number}
      </span>
      <div className={cn("flex min-w-0 flex-1 flex-col gap-3", !last && "pb-7")}>
        <div className="flex min-h-6 flex-col justify-center">
          <h3 className="text-sm font-semibold">{title}</h3>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
        {children}
      </div>
    </li>
  );
}

export function AddProviderForm({
  firstProvider,
  busy,
  codexStatus,
  bare = false,
  onConnect,
  onCancel,
  onBeginCodexSignIn,
  onSignOutCodex,
}: {
  firstProvider: boolean;
  busy: boolean;
  codexStatus: CodexAuthStatus;
  /** Drop the card frame and its heading, for a host that already titles this
      step (the welcome page) and would otherwise nest a card inside a card. */
  bare?: boolean;
  /** Resolves true when the provider connected — the codex auto-connect uses
      the result to know whether to offer a retry. */
  onConnect: (draft: DraftProvider) => Promise<boolean>;
  onCancel?: () => void;
  onBeginCodexSignIn: () => void;
  onSignOutCodex: () => void;
}) {
  const [draft, setDraft] = useState<DraftProvider>(() => newDraft());
  const [access, setAccess] = useState<AccessMethod | null>(null);
  const [kindChosen, setKindChosen] = useState(false);
  const [codexConnectFailed, setCodexConnectFailed] = useState(false);
  const codexConnectAttempted = useRef(false);

  const providerOptions = PROVIDER_OPTIONS.filter((option) => option.access === access);

  const keyConsole = catalogEntry(draft.kind).keyConsole;
  const codexSignedInWithoutCodex = codexStatus.state === "signed-in" && !planIncludesCodex(codexStatus.planType);
  const credentialsReady =
    kindChosen &&
    (draft.kind === "codex"
      ? codexStatus.state === "signed-in" && !codexSignedInWithoutCodex
      : draft.kind === "remixlet"
        ? draft.baseUrl.trim().length > 0
        : draft.apiKey.trim().length > 0);

  // The ChatGPT route has no connect button: the sign-in is the whole ask, so
  // the moment it lands (or the provider is picked while already signed in)
  // the connection check and model listing run on their own. The ref makes
  // each ready state connect once — a failure surfaces as a retry button, not
  // a loop — and signing out re-arms it.
  const connectCodex = () => {
    codexConnectAttempted.current = true;
    setCodexConnectFailed(false);
    void onConnect(draft).then((connected) => {
      if (!connected) setCodexConnectFailed(true);
    });
  };
  useEffect(() => {
    if (draft.kind !== "codex" || !credentialsReady) {
      codexConnectAttempted.current = false;
      return;
    }
    if (busy || codexConnectAttempted.current) return;
    connectCodex();
  });

  const credentialStep =
    draft.kind === "codex" ? (
      <div
        className={cn(
          "flex items-center justify-between gap-3 rounded-lg border p-3",
          codexSignedInWithoutCodex && "border-destructive/50 bg-destructive/5",
        )}
      >
        <div>
          <p className="text-sm font-medium">ChatGPT account</p>
          <p
            id="codex-status"
            className={cn("text-xs", codexSignedInWithoutCodex ? "text-destructive" : "text-muted-foreground")}
          >
            {codexStatus.state === "signed-in"
              ? codexSignedInWithoutCodex
                ? `Signed in as ${codexStatus.email} — this account is on ChatGPT Free, which doesn't include model access for other apps. Pick another provider.`
                : busy
                  ? `Signed in as ${codexStatus.email} — checking the connection and listing your models…`
                  : `Signed in as ${codexStatus.email} · ${codexStatus.planType}`
              : codexStatus.state === "pending"
                ? "OpenAI is waiting for you to confirm the account shown."
                : "Use the Codex models included with your paid ChatGPT plan."}
          </p>
        </div>
        {codexStatus.state === "signed-in" ? (
          <div className="flex shrink-0 items-center gap-2">
            {busy ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : codexConnectFailed ? (
              <Button id="codex-retry-connect" type="button" size="sm" onClick={connectCodex}>
                Try again
              </Button>
            ) : null}
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onSignOutCodex}>
              Sign out
            </Button>
          </div>
        ) : (
          <Button id="codex-signin" type="button" size="sm" onClick={onBeginCodexSignIn}>
            {codexStatus.state === "pending" ? "Restart sign-in" : "Continue with ChatGPT"}
          </Button>
        )}
      </div>
    ) : draft.kind === "remixlet" ? (
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor="provider-base-url">Base URL</FieldLabel>
          <Input
            id="provider-base-url"
            value={draft.baseUrl}
            onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            placeholder="https://openrouter.ai/api/v1"
          />
          <FieldDescription>The endpoint root, up to and including the version segment.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="provider-api-key">API key (if the endpoint needs one)</FieldLabel>
          <div className="relative">
            <KeyRound className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
            <Input
              id="provider-api-key"
              type="password"
              value={draft.apiKey}
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
              className="pl-9"
              placeholder="Leave blank for local endpoints without auth"
            />
          </div>
          <FieldDescription>Stored locally by the extension and sent only to this endpoint.</FieldDescription>
        </Field>
      </FieldGroup>
    ) : (
      <Field>
        <FieldLabel htmlFor="provider-api-key">API key</FieldLabel>
        <div className="relative">
          <KeyRound className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
          <Input
            id="provider-api-key"
            type="password"
            value={draft.apiKey}
            onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
            className="pl-9"
            placeholder={`Paste your ${PROVIDER_DEFAULTS[draft.kind].label} API key`}
          />
        </div>
        <FieldDescription>
          {keyConsole && (
            <>
              Create one at{" "}
              <a
                href={keyConsole.url}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                {keyConsole.label}
              </a>
              .{" "}
            </>
          )}
          Stored locally by the extension and sent only to this provider.
        </FieldDescription>
      </Field>
    );

  const advancedFields = (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
        <ChevronDown className="size-3.5 -rotate-90 transition-transform group-data-panel-open:rotate-0" />
        Advanced options
      </CollapsibleTrigger>
      <CollapsibleContent>
        <FieldGroup className="mt-3 gap-4 rounded-lg border bg-muted/25 p-3">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="provider-name">Display name</FieldLabel>
              <Input
                id="provider-name"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </Field>
            {draft.kind !== "remixlet" && (
              <Field>
                <FieldLabel htmlFor="provider-base-url">Base URL</FieldLabel>
                <Input
                  id="provider-base-url"
                  value={draft.baseUrl}
                  onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                />
              </Field>
            )}
          </div>
          <Field>
            <FieldLabel htmlFor="provider-fallback-models">Model IDs</FieldLabel>
            <Textarea
              id="provider-fallback-models"
              rows={2}
              value={draft.fallbackModels}
              onChange={(event) => setDraft({ ...draft, fallbackModels: event.target.value })}
              placeholder="One per line — only needed when the provider cannot list models"
            />
            <FieldDescription>
              Remixlet asks the provider for its models; these are used only if that fails.
            </FieldDescription>
          </Field>
        </FieldGroup>
      </CollapsibleContent>
    </Collapsible>
  );

  const steps = (
    <ol className="flex flex-col">
      <Step number={1} title="How do you want to connect?" done={access !== null} last={access === null}>
        <div className="grid gap-2 sm:grid-cols-2" role="list" aria-label="Access methods">
          {ACCESS_OPTIONS.map((option) => {
            const selected = access === option.method;
            return (
              <button
                key={option.method}
                type="button"
                data-access-option={option.method}
                aria-pressed={selected}
                onClick={() => {
                  if (access === option.method) return;
                  setAccess(option.method);
                  setKindChosen(false);
                  setDraft(newDraft());
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50",
                  selected ? "border-primary bg-primary/5" : "hover:border-primary/40",
                )}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                  {option.method === "subscription" ? (
                    <BadgeCheck className="size-5 text-muted-foreground" />
                  ) : (
                    <KeyRound className="size-5 text-muted-foreground" />
                  )}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium">{option.title}</span>
                  <span className="text-xs text-muted-foreground">{option.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </Step>

      {access !== null && (
        <Step number={2} title="Choose a provider" done={kindChosen} last={!kindChosen}>
          <div className="grid gap-2 sm:grid-cols-2" role="list" aria-label="Providers">
            {providerOptions.map((option) => {
              const selected = kindChosen && draft.kind === option.kind;
              return (
                <button
                  key={option.kind}
                  type="button"
                  data-provider-option={option.kind}
                  aria-pressed={selected}
                  onClick={() => {
                    setDraft(newDraft(option.kind));
                    setKindChosen(true);
                  }}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50",
                    selected ? "border-primary bg-primary/5" : "hover:border-primary/40",
                  )}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <ProviderLogo kind={option.kind} className="size-5" />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium">{option.title}</span>
                    <span className="text-xs text-muted-foreground">{option.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Step>
      )}

      {kindChosen && (
        <Step
          number={3}
          title={
            draft.kind === "codex"
              ? "Sign in with ChatGPT"
              : draft.kind === "remixlet"
                ? "Enter the endpoint details"
                : `Add your ${PROVIDER_DEFAULTS[draft.kind].label} API key`
          }
          hint={
            draft.kind === "codex"
              ? "Once you're signed in, Remixlet checks the connection and lists the models you can pick in chat."
              : undefined
          }
          done={credentialsReady}
          last={draft.kind === "codex" || !credentialsReady}
        >
          {credentialStep}
          {/* The ChatGPT route is fully determined by the sign-in: name, endpoint
              and model list all come from the provider, so there is nothing to tune —
              and nothing left to click: signing in connects (see connectCodex). */}
          {draft.kind !== "codex" && advancedFields}
        </Step>
      )}

      {credentialsReady && draft.kind !== "codex" && (
        <Step
          number={4}
          title="Connect"
          hint="Remixlet checks the connection and lists the models you can pick in chat."
          done={false}
          last
        >
          <Button
            id="connect-provider"
            type="button"
            className="self-start"
            disabled={busy}
            onClick={() => onConnect(draft)}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Plus />}
            Connect and find models
          </Button>
        </Step>
      )}
    </ol>
  );

  if (bare) return steps;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="add-provider-heading">
      {onCancel && (
        <Button type="button" variant="ghost" size="sm" className="self-start" onClick={onCancel}>
          <ArrowLeft />
          Back to providers
        </Button>
      )}
      <Card>
        <CardHeader>
          <CardTitle id="add-provider-heading">
            {firstProvider ? "Connect your first provider" : "Add a provider"}
          </CardTitle>
          <CardDescription>Pick where your models come from — credentials stay on this device.</CardDescription>
        </CardHeader>
        <CardContent>{steps}</CardContent>
      </Card>
    </section>
  );
}
