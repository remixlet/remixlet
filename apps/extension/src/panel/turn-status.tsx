// The running indicator under the transcript while a turn is in flight: a
// spinner, the model call's own progress words (chat-phrases.tsx), and the
// elapsed ticker. Its own module so the states can be rendered on their own —
// a long quiet, each retry with its reason — outside a live run.
import { Loader2 } from "lucide-react";
import type { ModelWaitEvent } from "../agent/types.js";
import { modelWaitLabel } from "./chat-phrases.js";

export function TurnStatus({ wait, elapsedMs }: { wait: ModelWaitEvent | null; elapsedMs: number }) {
  const words = modelWaitLabel(wait);
  return (
    /* pl-1 + 13px icon + leading-[15px] mirror .msg.tool row geometry so the
       spinner sits exactly under the activity icons. The words are a block
       beside the spinner, not flex siblings: a retry label is long enough to
       wrap in a narrow panel, and the ticker flows after its last line while
       the reason takes a full line of its own underneath. */
    <div id="turn-status" className="mt-2 flex items-start gap-2 pl-1 text-xs leading-[15px] text-muted-foreground" aria-live="polite">
      <Loader2 className="mt-px size-[13px] shrink-0 animate-spin" aria-hidden />
      <div className="min-w-0 flex-1">
        <span>{words.label}</span> <span className="ml-1 tabular-nums">{(elapsedMs / 1000).toFixed(1)}s</span>
        {words.detail && <div className="mt-0.5 opacity-70 [overflow-wrap:anywhere]">{words.detail}</div>}
      </div>
    </div>
  );
}
