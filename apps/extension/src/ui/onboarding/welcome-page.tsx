// The welcome page (welcome.html): Remixlet's only first-run surface, and a
// page of its own rather than a route inside the control center. Setup is a
// gate, not a tab — until both conditions in readiness.ts hold, this is the
// only place the extension will let anyone in, so it carries no sidebar, no
// navigation, and nothing to click but the current step.
//
// Three stages, strictly in order:
//   1 · Unlock the user-script lane — the one thing Remixlet cannot do for
//       itself. Which switch that is depends on the browser, and only one is
//       ever shown: Chrome 138+ has the per-extension "Allow user scripts"
//       toggle, older Chrome gates the API on Developer mode, Firefox asks
//       for an optional permission (platform/user-scripts-gate.ts decides).
//       Availability is fixed per JS context at CREATION, so the page cannot
//       re-ask its own context. It POLLS by remounting a probe iframe (fresh
//       context per tick, see onboarding-probe.ts) and goes green live. No
//       confirmation press: the moment the probe reports the flip the page
//       asks the worker to reconcile; if the worker's own context predates
//       the flip it reloads the extension, and boot reopens this page in its
//       all-green state (worker index.ts).
//   2 · Pin the toolbar button — optional but it must be ANSWERED: the next
//       stage stays locked until the user pins (watched live where the
//       browser exposes action.getUserSettings().isOnToolbar, same spirit as
//       the stage-1 poll) or explicitly skips. The answer never touches
//       data-setup — a skip isn't persisted, and "set up" stays re-derivable
//       from facts alone (readiness.ts). Safari has no pinnable toolbar
//       button, so the stage doesn't exist there and the numbers shift down.
//   3 · Connect a model provider — locked until stages 1 and 2 are settled,
//       both because a half-installed extension is a bad place to type an
//       API key and because stage 1's finish restarts the extension
//       underneath us.
//
// data-* on <body> is the machine-readable state for the harness:
//   data-status: locked → unlocked (toggle seen, finish pending) → ready
//                policy-blocked when an admin stripped the permission,
//                unsupported where there is no user-script sandbox at all.
//   data-setup:  incomplete | complete — the gate the control center reads.

import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, LoaderCircle, Lock } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  requestUserScriptsAccess,
  userScriptsBlockedByPolicy,
  userScriptsSetupKind,
  userScriptsUnlocked,
} from "../../platform/capabilities.js";
import { BROWSER_TARGET, ext } from "../../platform/ext.js";
import { scriptInjector } from "../../platform/script-injector.js";
import type { PanelToWorker, WorkerToPanel } from "../../shared/protocol.js";
import { GradientBackdrop } from "../gradient-backdrop.js";
import { RemixletLogo } from "../logo.js";
import { AddProviderForm } from "../provider-settings/add-provider-form.js";
import { useProviderCatalog } from "../provider-settings/use-provider-catalog.js";
import { modelsReady } from "./readiness.js";

type ScriptStatus = "locked" | "unlocked" | "finishing" | "ready" | "policy-blocked" | "unsupported";

const POLL_MS = 2000;

/** Whether the toolbar button is pinned. null means this browser cannot say
    (no action.getUserSettings), so the pin stage shows instructions without a
    live check. Like the stage-1 probe, it polls while unpinned so the page
    notices the pin on its own; one-way — an optional step never un-completes
    itself under the user. */
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
        {/* An active stage is always one the page is waiting on, so in-progress
            is drawn as a spinner ring around the number instead of a separate
            status line inside the card. */}
        <span className={cn("relative shrink-0", !collapsed && "mt-0.5")}>
          {state === "active" && (
            <LoaderCircle className="absolute -inset-1 size-9 animate-spin text-primary" strokeWidth={1.5} aria-hidden />
          )}
          <span
            className={cn(
              "flex size-7 items-center justify-center rounded-full border text-[13px] font-semibold tabular-nums",
              state === "done" && "border-primary bg-primary text-primary-foreground",
              state === "active" && "border-primary text-foreground",
              state === "locked" && "text-muted-foreground",
            )}
          >
            {state === "done" ? (
              <Check className="size-4" />
            ) : state === "locked" ? (
              <Lock className="size-3.5" />
            ) : (
              number
            )}
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

function ScriptStage({
  status,
  onRequestPermission,
  settingsLinkBlocked,
  onOpenExtensionsPage,
}: {
  status: ScriptStatus;
  onRequestPermission: () => void;
  settingsLinkBlocked: boolean;
  onOpenExtensionsPage: (url: string) => void;
}) {
  const setupKind = userScriptsSetupKind();

  if (setupKind === "unsupported") {
    return (
      <Alert>
        <AlertTitle>This browser has no user-script sandbox</AlertTitle>
        <AlertDescription>
          Safari cannot run generated JavaScript for an extension, so Remixlet works in a reduced scope here: CSS-only
          remixlets and supported network rules, with every unsupported capability disabled explicitly rather than
          failing quietly.
        </AlertDescription>
      </Alert>
    );
  }

  if (status === "policy-blocked") {
    return (
      <Alert variant="destructive" id="policy-alert">
        <CircleAlert />
        <AlertTitle>Blocked by your organization</AlertTitle>
        <AlertDescription>
          Your browser is managed, and its policy removes the user-scripts permission from this extension. There is no
          toggle to flip — ask your administrator to allow user scripts for Remixlet.
        </AlertDescription>
      </Alert>
    );
  }

  if (setupKind === "permission") {
    return (
      <>
        <p className="text-sm text-muted-foreground">Firefox can grant this optional permission directly.</p>
        {status === "locked" && (
          <Button id="allow-user-scripts" type="button" className="self-start" onClick={onRequestPermission}>
            Allow user scripts
          </Button>
        )}
      </>
    );
  }

  // Which switch this Chrome actually draws, decided by probe in
  // platform/user-scripts-gate.ts. Naming both would send most people hunting
  // for a control their browser does not have.
  const devMode = setupKind === "chrome-dev-mode";

  return (
    <>
      <ol id={devMode ? "dev-mode-steps" : "toggle-steps"} className="flex flex-col gap-2.5 text-sm">
        <li className="flex gap-2.5">
          <span aria-hidden className="w-4 shrink-0 tabular-nums text-muted-foreground">
            1
          </span>
          {devMode ? (
            <span>
              Open{" "}
              <Button
                id="open-extensions-list"
                type="button"
                variant="link"
                className="h-auto p-0 text-sm font-normal underline underline-offset-2"
                onClick={() => onOpenExtensionsPage("chrome://extensions/")}
              >
                the browser’s extensions page
              </Button>
              .
            </span>
          ) : (
            <span>
              Open{" "}
              <Button
                id="open-extension-details"
                type="button"
                variant="link"
                className="h-auto p-0 text-sm font-normal underline underline-offset-2"
                onClick={() => onOpenExtensionsPage(`chrome://extensions/?id=${ext.runtime.id}#allow-user-scripts`)}
              >
                Remixlet’s browser settings page
              </Button>
              .
            </span>
          )}
        </li>
        <li className="flex gap-2.5">
          <span aria-hidden className="w-4 shrink-0 tabular-nums text-muted-foreground">
            2
          </span>
          {devMode ? (
            <span>
              Turn on <strong className="font-semibold">Developer mode</strong>, the switch at the top right of that
              page.
            </span>
          ) : (
            <span>
              Turn on <strong className="font-semibold">Allow user scripts</strong>.
            </span>
          )}
        </li>
      </ol>

      {devMode && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Chrome only added a per-extension switch for this in version 138. On this one, Developer mode is the switch
          that lets any extension run user scripts — it is the whole step.
        </p>
      )}

      {settingsLinkBlocked && (
        <p id="settings-link-fallback" className="text-xs text-muted-foreground">
          Your browser wouldn’t let us open that page.{" "}
          {devMode ? (
            <>
              Go to <code className="rounded bg-muted px-1">chrome://extensions</code> yourself and turn on{" "}
              <strong>Developer mode</strong> at the top right.
            </>
          ) : (
            <>
              Go to <code className="rounded bg-muted px-1">chrome://extensions</code> yourself, find{" "}
              <strong>Remixlet</strong>, and click <strong>Details</strong>.
            </>
          )}
        </p>
      )}

      {(status === "unlocked" || status === "finishing") && (
        <p className="flex items-center gap-2 text-sm">
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          <span>
            <strong className="font-semibold">{devMode ? "Developer mode is on." : "Toggle detected."}</strong>{" "}
            Restarting to pick it up — this page comes back on its own…
          </span>
        </p>
      )}
    </>
  );
}

export function WelcomePage() {
  const setupKind = userScriptsSetupKind();
  // If THIS page's context was created after the toggle flip (a fresh install
  // with the toggle already on, or the post-restart reopen), stage 1 is done.
  const [scriptStatus, setScriptStatus] = useState<ScriptStatus>(() =>
    userScriptsUnlocked() ? "ready" : setupKind === "unsupported" ? "unsupported" : "locked",
  );
  const [probeTick, setProbeTick] = useState(0);
  const [settingsLinkBlocked, setSettingsLinkBlocked] = useState(false);
  const statusRef = useRef(scriptStatus);
  statusRef.current = scriptStatus;

  const catalog = useProviderCatalog();
  const pinned = usePinnedToToolbar();
  // Pinning is stage 2, and it blocks stage 3 until ANSWERED — pin it (the
  // poll notices and moves on by itself) or decline it — but never gates
  // data-setup: the decline isn't persisted, and "set up" must stay
  // re-derivable from facts alone (readiness.ts).
  const [pinSkipped, setPinSkipped] = useState(false);
  const pinStageShown = BROWSER_TARGET !== "safari";
  const pinResolved = !pinStageShown || pinned === true || pinSkipped;
  const scriptsDone = scriptStatus === "ready" || scriptStatus === "unsupported";
  const modelsDone = catalog.loaded && modelsReady(catalog.settings);
  const complete = scriptsDone && modelsDone;

  useEffect(() => {
    document.body.dataset.status = scriptStatus;
    document.body.dataset.setup = complete ? "complete" : "incomplete";
  }, [scriptStatus, complete]);

  // Policy check is async; it can only ever escalate locked → policy-blocked.
  useEffect(() => {
    void userScriptsBlockedByPolicy().then((blocked) => {
      if (blocked && statusRef.current === "locked") setScriptStatus("policy-blocked");
    });
  }, []);

  // The initial "ready" trusted namespace presence, which a context that
  // outlived the grant still has after the toggle is turned OFF — only a real
  // call tells (script-injector.ts). Verify once; a revoked lane drops the
  // step back to locked, which restarts the iframe poll and the instructions.
  useEffect(() => {
    if (!userScriptsUnlocked()) return;
    void scriptInjector()
      .verifyAvailable()
      .then((available) => {
        if (!available && statusRef.current === "ready") setScriptStatus("locked");
      });
  }, []);

  // No confirmation press after the flip: the probe's verdict IS the fact,
  // so the finish (and the restart it may carry) begins the moment it lands.
  useEffect(() => {
    if (scriptStatus === "unlocked") finishScriptSetup();
  }, [scriptStatus]);

  // The poll: remount the probe iframe every tick; it posts back whether a
  // freshly created context sees the API.
  useEffect(() => {
    if (scriptStatus !== "locked") return;
    const onMessage = (event: MessageEvent): void => {
      // SAFETY: onboarding-probe.ts sends this fixed message contract from the extension iframe.
      const data = event.data as { kind?: string; unlocked?: boolean } | undefined;
      if (data?.kind === "rmx.userScriptsProbe" && data.unlocked && statusRef.current === "locked") {
        setScriptStatus("unlocked");
      }
    };
    window.addEventListener("message", onMessage);
    const interval = setInterval(() => setProbeTick((tick) => tick + 1), POLL_MS);
    return () => {
      window.removeEventListener("message", onMessage);
      clearInterval(interval);
    };
  }, [scriptStatus]);

  function finishScriptSetup(): void {
    setScriptStatus("finishing");
    const message: PanelToWorker = { kind: "onboarding.finish" };
    // SAFETY: the worker replies to onboarding.finish with the WorkerToPanel protocol union.
    void (ext.runtime.sendMessage(message) as Promise<WorkerToPanel>)
      .then((reply) => {
        // reloading:true means the extension restarts and boot reopens this
        // page fresh (already "ready"); if we're still alive, we're done now.
        if (reply.kind === "onboarding.finished" && !reply.reloading) setScriptStatus("ready");
      })
      .catch(() => {
        // The worker died mid-restart before replying — the reopen is coming.
      });
  }

  // Anchor links to chrome:// are blocked, but extensions may open those URLs
  // through tabs.create — chrome://extensions/?id=<us> lands on our own
  // Details page, where the toggle lives. Some Chromium forks refuse; fall
  // back to manual instructions if the call rejects.
  function openExtensionsPage(url: string): void {
    void Promise.resolve(ext.tabs.create({ url })).catch(() => setSettingsLinkBlocked(true));
  }

  function requestFirefoxPermission(): void {
    void requestUserScriptsAccess().then((granted) => {
      if (granted) setScriptStatus("unlocked");
    });
  }

  // The rail's segments mirror the stages on THIS browser — Safari has no
  // pin stage, so it counts two.
  const railSegments = pinStageShown ? [scriptsDone, pinResolved, modelsDone] : [scriptsDone, modelsDone];
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

        <div className="flex flex-col gap-3">
          <Stage
            number={1}
            title="Allow Remixlet to run"
            doneTitle={scriptsDone ? "Allowed Remixlet to run" : undefined}
            summary={
              scriptsDone
                ? "Allowed Remixlet to run."
                : setupKind === "unsupported"
                  ? "This browser runs Remixlet in a reduced scope."
                  : BROWSER_TARGET === "firefox"
                    ? "Remixlets are user scripts, which need special permission from Firefox to run. Mozilla doesn’t review the generated code, so Firefox has to warn it could be unsafe — but Remixlet takes several measures to make sure code only runs with your permission."
                    : "Remixlets are user scripts, which need special permission from Chrome to run. Google doesn’t review the generated code, so Chrome has to warn it could be unsafe — but Remixlet takes several measures to make sure code only runs with your permission."
            }
            state={scriptsDone ? "done" : "active"}
          >
            {!scriptsDone && (
              <ScriptStage
                status={scriptStatus}
                onRequestPermission={requestFirefoxPermission}
                settingsLinkBlocked={settingsLinkBlocked}
                onOpenExtensionsPage={openExtensionsPage}
              />
            )}
          </Stage>

          {/* Stage 2 blocks until answered — pin it (the poll notices) or
              decline it — but data-setup never depends on the answer. Safari
              has no pinnable toolbar button, so the stage doesn't exist
              there and stage numbers shift down. */}
          {pinStageShown && (
            <Stage
              number={2}
              title="Pin Remixlet to your toolbar"
              doneTitle={pinned ? "Pinned Remixlet to toolbar" : pinSkipped ? "Skipped pinning Remixlet to toolbar" : undefined}
              summary={
                pinned
                  ? "Pinned — the Remixlet button now sits in the toolbar on every page."
                  : pinSkipped
                    ? "Skipped — you can pin it any time from the browser’s extensions menu."
                    : "This will allow easy every day access to the per-site controls for Remixlet."
              }
              state={pinned || pinSkipped ? "done" : scriptsDone ? "active" : "locked"}
            >
              {!pinned && !pinSkipped && scriptsDone && (
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
            number={pinStageShown ? 3 : 2}
            title={modelsDone ? "Connected a model provider" : "Connect a model provider"}
            summary={
              modelsDone
                ? `${catalog.settings.providers.length} provider${catalog.settings.providers.length === 1 ? "" : "s"} connected — its models are ready to pick in chat.`
                : "Remixlet brings the agent, you bring the model: sign in with a plan you already pay for, or paste an API key. Credentials stay on this device."
            }
            state={modelsDone ? "done" : scriptsDone && pinResolved ? "active" : "locked"}
          >
            {!scriptsDone ? (
              <p id="model-stage-locked" className="text-sm text-muted-foreground">
                Finish step 1 first — Remixlet restarts itself at the end of it, which would throw away anything typed
                here.
              </p>
            ) : !pinResolved || !catalog.loaded ? null : !modelsDone ? (
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

      {/* Remounted every tick: key forces a fresh document, hence a fresh
          context whose bindings reflect the CURRENT toggle state. */}
      {scriptStatus === "locked" && (
        <iframe key={probeTick} src="probe.html" title="probe" className="hidden" aria-hidden />
      )}
    </div>
  );
}
