// The OAuth callback landing page. The DNR session rule (or the webNavigation
// fallback) rewrites http://localhost:1455/auth/callback?... to this extension
// page with the query string carried through — nothing is ever sent to port
// 1455. All this page does is relay code+state to the worker and render the
// outcome; verification and token exchange are worker-side (codex-auth.ts).

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import { ext } from "../platform/ext.js";
import type { PanelToWorker, WorkerToPanel } from "../shared/protocol.js";
import { followThemePreference } from "./theme.js";

interface Outcome {
  phase: "pending" | "ok" | "error";
  title: string;
  detail: string;
}

async function resolveOutcome(): Promise<Outcome> {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const state = params.get("state");
  const providerError = params.get("error");
  if (providerError) {
    return { phase: "error", title: "Sign-in failed", detail: `${providerError}: ${params.get("error_description") ?? "no details"}` };
  }
  if (!code || !state) {
    return { phase: "error", title: "Sign-in failed", detail: "The callback is missing its code or state parameter." };
  }
  const message: PanelToWorker = { kind: "codex.callback", code, state };
  // SAFETY: the worker protocol returns codex.callbackResult for a codex.callback request.
  const reply = (await ext.runtime.sendMessage(message)) as Extract<WorkerToPanel, { kind: "codex.callbackResult" }>;
  if (reply.ok && reply.account) {
    // The worker closes this tab shortly; window.close() is unreliable for
    // tabs the page's script didn't open.
    return { phase: "ok", title: "Signed in", detail: `${reply.account.email} (${reply.account.planType}) — you can close this tab.` };
  }
  return { phase: "error", title: "Sign-in failed", detail: reply.message ?? "Unknown error." };
}

function CallbackApp() {
  const [outcome, setOutcome] = useState<Outcome>({
    phase: "pending",
    title: "Signing in…",
    detail: "Finishing up with ChatGPT.",
  });

  useEffect(() => {
    void resolveOutcome().then(setOutcome);
  }, []);

  return (
    <main className="flex h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm text-center">
        <CardHeader>
          <CardTitle id="headline" className={cn(outcome.phase === "error" && "text-destructive")}>
            {outcome.title}
          </CardTitle>
          <CardDescription id="detail" className="[overflow-wrap:anywhere]">
            {outcome.detail}
          </CardDescription>
        </CardHeader>
      </Card>
    </main>
  );
}

followThemePreference();
createRoot(document.getElementById("root")!).render(<CallbackApp />);
