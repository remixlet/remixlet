// The one mid-chat permission card. Two asks render through it — the
// capability request (grants the remixlet, durably, via the manifest) and the
// dev-observe request (grants the agent, for this chat only) — and to the
// person clicking they are the same act, so they get the same treatment: a
// title, one row per thing being allowed, and two buttons. What differs
// travels in the props: the title, the rows, and the allow label (a grant
// that reloads the page says so on the button). Copy is extension-authored
// throughout; nothing here renders model prose.

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { LucideIcon } from "lucide-react";
import type { CapabilityExplanation } from "../shared/capability-copy.js";

/** One thing being allowed: the shared copy plus the icon that marks it as a list item. */
export interface PermissionRow extends CapabilityExplanation {
  icon: LucideIcon;
}

export interface PermissionCardProps {
  /** Element id prefix: `${id}`, `${id}-dismiss`, `${id}-allow`. Suites select on these. */
  id: string;
  title: string;
  rows: readonly PermissionRow[];
  allowLabel: string;
  allowDisabled: boolean;
  onAllow: () => void;
  onDismiss: () => void;
}

export function PermissionCard({ id, title, rows, allowLabel, allowDisabled, onAllow, onDismiss }: PermissionCardProps) {
  return (
    // One card, one border: the rows are plain text inside it, not nested
    // boxes, and the icon is what marks each as a list item (same treatment
    // as the activation dialog). Divs rather than <p> because AlertDescription
    // puts a 1rem margin under every non-last paragraph.
    <Alert id={id} className="m-3 max-h-[45vh] w-auto shrink-0 gap-2 overflow-y-auto">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.title} className="requested-capability flex items-start gap-2.5">
              <row.icon className="mt-px size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0">
                <div className="text-xs font-medium text-foreground">{row.title}</div>
                <div className="mt-1 text-xs">{row.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      </AlertDescription>
      <div className="mt-1 flex justify-end gap-2">
        <Button id={`${id}-dismiss`} type="button" variant="ghost" size="sm" onClick={onDismiss}>
          Not now
        </Button>
        <Button id={`${id}-allow`} type="button" size="sm" disabled={allowDisabled} onClick={onAllow}>
          {allowLabel}
        </Button>
      </div>
    </Alert>
  );
}
