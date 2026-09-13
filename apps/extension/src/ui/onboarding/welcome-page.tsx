// The welcome page (welcome.html): Remixlet's only first-run surface, and a
// page of its own rather than a route inside the control center. Setup is a
// gate, not a tab — until the condition in readiness.ts holds, this is the
// only place the extension will let anyone in, so it carries no sidebar, no
// navigation, and nothing to click but the current step.
//
// Two stages, strictly in order:
//   1 · Pin the toolbar button — optional but it must be ANSWERED: the next
//       stage stays locked until the user pins (watched live where the
//       browser exposes action.getUserSettings().isOnToolbar) or explicitly
//       skips. The answer never touches data-setup — a skip isn't persisted,
//       and "set up" stays re-derivable from facts alone (readiness.ts).
//       Safari has no pinnable toolbar button, so the stage doesn't exist
//       there and the numbers shift down.
//   2 · Connect a model provider — the one thing Remixlet cannot do for
//       itself. Locked until stage 1 is settled: a half-answered page is a
//       bad place to type an API key.
//
// Nothing here asks the browser for anything. The user-scripts permission and
// its "Allow user scripts" toggle are gone (wiki/design/mediated-execution.md,
// "The user-scripts permission"); what the box needs is fixed at install, and
// a browser that lacks it (Firefox, Safari) runs in limited mode, which the
// page says up front with the capability's own reason.
//
// data-* on <body> is the machine-readable state for the harness:
//   data-setup:  incomplete | complete — the gate the control center reads.

import { useEffect, useState } from "react";
import { Check, CircleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { PlatformCapabilities } from "../../platform/capabilities.js";
import { BROWSER_TARGET, ext } from "../../platform/ext.js";
import { send } from "../control-center/send.js";
import { GradientBackdrop } from "../gradient-backdrop.js";
import { RemixletLogo } from "../logo.js";
import { AddProviderForm } from "../provider-settings/add-provider-form.js";
import { useProviderCatalog } from "../provider-settings/use-provider-catalog.js";
import { modelsReady } from "./readiness.js";

const POLL_MS = 2000;

/** Whether the toolbar button is pinned. null means this browser cannot say
    (no action.getUserSettings), so the pin stage shows instructions without a
    live check. It polls while unpinned so the page notices the pin on its
    own; one-way — an optional step never un-completes itself under the user. */
function usePinnedToToolbar(): boolean | null {
  const supported = ext.action?.getUserSettings !== undefined;
  const [pinned, setPinned] = useState<boolean | null>(supported ? false : null);
  useEffect(() => {
    if (pinned !== false) return;
    let cancelled = false;
    const check = (): void => {
      void ext.action.getUserSettings().then((settings) => {
        if (!cancelled && settings.isOnToolbar) setPinned(true);
      });
    };
    check();
    const interval = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pinned]);
  return pinned;
}

/** What the worker detected (platform/capabilities.ts); null until it answers. */
function useCapabilities(): PlatformCapabilities | null {
  const [capabilities, setCapabilities] = useState<PlatformCapabilities | null>(null);
  useEffect(() => {
    void send({ kind: "capabilities.get" }, "capabilities.result")
      .then((reply) => setCapabilities(reply.capabilities))
      .catch(() => {
        // A worker that does not answer leaves the note off; the manager and
        // panel carry the same reasons.
      });
  }, []);
  return capabilities;
}

/** One numbered stage in the page's rail. Future stages are visibly locked
    rather than hidden: the shape of the setup is knowable from the first
    paint, even though only one stage is ever actionable. */
function Stage({
  number,
  title,
  doneTitle,
  summary,
  state,
  children,
}: {
  number: number;
  title: string;
  /** Replaces title+summary with a single centered line once state is "done" —
      done just restates the title in the past tense, so the summary (which
      duplicated it) is dropped rather than shown alongside. */
  doneTitle?: string;
  summary: string;
  state: "locked" | "active" | "done";
  children?: React.ReactNode;
}) {
  const collapsed = state === "done" && doneTitle !== undefined;
  return (
    <section
      data-stage={number}
      data-state={state}
      className={cn(
        "relative flex flex-col gap-4 rounded-[var(--r-frame)] border bg-card p-5 transition-opacity sm:p-6",
        state === "active" && "shadow-[var(--ring-soft)]",
        state === "locked" && "opacity-55",
      )}
    >
      <div className={cn("flex gap-3.5", collapsed ? "items-center" : "items-start")}>
        <span className={cn("relative shrink-0", !collapsed && "mt-0.5")}>
          <span
            className={cn(
              "flex size-7 items-center justify-center rounded-full border text-[13px] font-semibold tabular-nums",
              state === "done" && "border-primary bg-primary text-primary-foreground",
              state === "active" && "border-primary text-foreground",
              state === "locked" && "text-muted-foreground",
            )}
          >
            {state === "done" ? <Check className="size-4" /> : number}
          </span>
        </span>
        {collapsed ? (
          <h2 className="min-w-0 flex-1 text-[15px] leading-6 font-semibold tracking-[-0.01em]">{doneTitle}</h2>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="text-[15px] leading-6 font-semibold tracking-[-0.01em]">{title}</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">{summary}</p>
          </div>
        )}
      </div>
      {children && <div className="flex flex-col gap-3 sm:pl-[2.625rem]">{children}</div>}
    </section>
  );
}

export function WelcomePage() {
  const catalog = useProviderCatalog();
  const capabilities = useCapabilities();
  const pinned = usePinnedToToolbar();
  // Pinning is stage 1, and it blocks stage 2 until ANSWERED — pin it (the
  // poll notices and moves on by itself) or decline it — but never gates
  // data-setup: the decline isn't persisted, and "set up" must stay
  // re-derivable from facts alone (readiness.ts).
  const [pinSkipped, setPinSkipped] = useState(false);
  const pinStageShown = BROWSER_TARGET !== "safari";
  const pinResolved = !pinStageShown || pinned === true || pinSkipped;
  const modelsDone = catalog.loaded && modelsReady(catalog.settings);
  const complete = modelsDone;
  const limitedReason = capabilities && !capabilities.box ? capabilities.disabledReasons.box : undefined;

  useEffect(() => {
    document.body.dataset.setup = complete ? "complete" : "incomplete";
  }, [complete]);

  // The rail's segments mirror the stages on THIS browser — Safari has no
  // pin stage, so it counts one.
  const railSegments = pinStageShown ? [pinResolved, modelsDone] : [modelsDone];
  const stagesDone = railSegments.filter(Boolean).length;

  return (
    <div id="welcome-page" className="relative isolate min-h-dvh overflow-hidden">
      <GradientBackdrop />

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-5 py-14 sm:py-20">
        <header className="flex flex-col items-start gap-5">
          {/* The marketing site's wordmark, verbatim: the shared mark at 18px
              next to the name (SiteChrome.tsx's .wordmark). */}
          <span className="flex items-center gap-2">
            <RemixletLogo className="size-[18px]" />
            <span className="text-base font-semibold tracking-[-0.01em]">Remixlet</span>
          </span>

          <div className="flex flex-col gap-2.5">
            <h1 className="text-3xl leading-tight font-semibold tracking-[-0.02em] text-balance sm:text-4xl">
              {complete ? "You’re ready to remix." : "Setup once, then remix any website."}
            </h1>
            {complete && (
              <p className="max-w-xl text-[15px] leading-relaxed text-muted-foreground text-pretty">
                Open any website and describe what you want to change.
              </p>
            )}
          </div>

          {/* Progress reads as a fraction and a rail — the same segments in
              every state, so nothing about the shape of setup changes as it
              fills. */}
          <div className="flex w-full flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground tabular-nums">
              {complete
                ? "Setup complete"
                : `Step ${Math.min(stagesDone + 1, railSegments.length)} of ${railSegments.length}`}
            </span>
            <div className="flex gap-1.5" aria-hidden>
              {railSegments.map((done, index) => (
                <span
                  key={index}
                  className={cn("h-1 flex-1 rounded-full transition-colors", done ? "bg-primary" : "bg-border")}
                />
              ))}
            </div>
          </div>
        </header>

        {limitedReason !== undefined && (
          <Alert id="limited-mode-alert">
            <CircleAlert />
            <AlertTitle>This browser runs Remixlet in limited mode</AlertTitle>
            <AlertDescription>{limitedReason}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-3">
          {/* Stage 1 blocks until answered — pin it (the poll notices) or
              decline it — but data-setup never depends on the answer. Safari
              has no pinnable toolbar button, so the stage doesn't exist
              there and stage numbers shift down. */}
          {pinStageShown && (
            <Stage
              number={1}
              title="Pin Remixlet to your toolbar"
              doneTitle={pinned ? "Pinned Remixlet to toolbar" : pinSkipped ? "Skipped pinning Remixlet to toolbar" : undefined}
              summary={
                pinned
                  ? "Pinned — the Remixlet button now sits in the toolbar on every page."
                  : pinSkipped
                    ? "Skipped — you can pin it any time from the browser’s extensions menu."
                    : "This will allow easy every day access to the per-site controls for Remixlet."
              }
              state={pinned || pinSkipped ? "done" : "active"}
            >
              {!pinned && !pinSkipped && (
                <>
                  <ol id="pin-steps" className="flex flex-col gap-2.5 text-sm">
                    <li className="flex gap-2.5">
                      <span aria-hidden className="w-4 shrink-0 tabular-nums text-muted-foreground">
                        1
                      </span>
                      <span>
                        Click the puzzle-piece <strong className="font-semibold">&quot;Extensions&quot;</strong> icon on
                        the right of the browser toolbar.
                      </span>
                    </li>
                    <li className="flex gap-2.5">
                      <span aria-hidden className="w-4 shrink-0 tabular-nums text-muted-foreground">
                        2
                      </span>
                      {BROWSER_TARGET === "firefox" ? (
                        <span>
                          Open the gear menu next to Remixlet and choose{" "}
                          <strong className="font-semibold">Pin to Toolbar</strong>.
                        </span>
                      ) : (
                        <span>
                          Click the pin next to <strong className="font-semibold">Remixlet</strong>.
                        </span>
                      )}
                    </li>
                  </ol>
                  <Button
                    id="skip-pinning"
                    type="button"
                    variant="outline"
                    className="mt-3 self-start"
                    onClick={() => setPinSkipped(true)}
                  >
                    Skip pinning
                  </Button>
                </>
              )}
            </Stage>
          )}

          <Stage
            number={pinStageShown ? 2 : 1}
            title={modelsDone ? "Connected a model provider" : "Connect a model provider"}
            summary={
              modelsDone
                ? `${catalog.settings.providers.length} provider${catalog.settings.providers.length === 1 ? "" : "s"} connected — its models are ready to pick in chat.`
                : "Sign in with ChatGPT or use an API key."
            }
            state={modelsDone ? "done" : pinResolved ? "active" : "locked"}
          >
            {!pinResolved || !catalog.loaded ? null : !modelsDone ? (
              <>
                {catalog.error && (
                  <Alert variant="destructive">
                    <CircleAlert />
                    <AlertTitle>Couldn’t connect</AlertTitle>
                    <AlertDescription>{catalog.error}</AlertDescription>
                  </Alert>
                )}
                {catalog.status && !catalog.error && (
                  <Alert>
                    <Check />
                    <AlertTitle>Sign-in started</AlertTitle>
                    <AlertDescription>{catalog.status}</AlertDescription>
                  </Alert>
                )}
                <AddProviderForm
                  firstProvider
                  bare
                  busy={catalog.busy}
                  codexStatus={catalog.codexStatus}
                  onConnect={catalog.addProvider}
                  onBeginCodexSignIn={catalog.beginCodexSignIn}
                  onSignOutCodex={catalog.signOutCodex}
                />
              </>
            ) : null}
          </Stage>
        </div>

        {complete && (
          <div id="ready-alert" className="flex flex-col gap-4 rounded-[var(--r-frame)] border bg-card p-5 sm:p-6">
            <div className="flex flex-col gap-1">
              <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Quickstart</h2>
            </div>
            <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm leading-relaxed text-muted-foreground marker:text-muted-foreground">
              <li>Go to any website you want to change.</li>
              <li>Press the Remixlet button in the browser toolbar.</li>
              <li>
                Choose <span className="font-medium text-foreground">Open chat</span> and describe your first change.
              </li>
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
