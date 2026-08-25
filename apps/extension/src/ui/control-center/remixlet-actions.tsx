// The rarely-used lifecycle controls for one remixlet — archive/restore and
// delete-forever. They are not worth standing buttons on the page, so every
// surface reaches them through a menu: a ⋯ dropdown beside the title, and on
// each sidebar row both a right-click menu and a ⋯ that fades in on hover.
// All of them share this file, so the confirmation copy and the guarantees
// behind it can only be written once.
//
// A failed action keeps its dialog open and says why. Silently closing would
// read as "done" when the remixlet is in fact still here.

import { useState, type ReactNode } from "react";
import { Archive, ArchiveRestore, EllipsisVertical, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import type { RegistryEntry } from "../../store/remixlet-store.js";
import { navigate, parseRoute } from "./router.js";
import { send } from "./send.js";

type LifecycleAction = {
  key: "archive" | "restore" | "destroy";
  label: string;
  icon: typeof Archive;
  destructive: boolean;
  onSelect: () => void;
};

interface LifecycleControls {
  actions: LifecycleAction[];
  busy: boolean;
  dialogs: ReactNode;
}

function useLifecycle(
  entry: RegistryEntry,
  onChanged: () => Promise<void>,
): LifecycleControls {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<"archive" | "destroy" | undefined>(undefined);
  const [error, setError] = useState("");

  function run(fn: () => Promise<void>, after?: () => void): void {
    if (busy) return;
    setBusy(true);
    setError("");
    void fn()
      .then(async () => {
        await onChanged();
        setConfirming(undefined);
        after?.();
      })
      .catch((cause: unknown) => setError(String(cause)))
      .finally(() => setBusy(false));
  }

  // Deleting the remixlet whose page is open leaves the route pointing at
  // nothing; deleting some other one from the sidebar must not move the user.
  function leaveIfViewing(): void {
    const route = parseRoute(location.hash);
    if (route.kind === "remixlet" && route.id === entry.id) navigate({ kind: "overview" });
  }

  const archived = entry.state === "archived";
  const actions: LifecycleAction[] = [
    archived
      ? {
          key: "restore",
          label: "Restore",
          icon: ArchiveRestore,
          destructive: false,
          onSelect: () => run(async () => void (await send({ kind: "remixlet.restore", id: entry.id }, "remixlet.entry"))),
        }
      : {
          key: "archive",
          label: "Archive",
          icon: Archive,
          destructive: false,
          onSelect: () => setConfirming("archive"),
        },
    { key: "destroy", label: "Delete", icon: Trash2, destructive: true, onSelect: () => setConfirming("destroy") },
  ];

  function closeOnDismiss(open: boolean): void {
    if (open) return;
    setConfirming(undefined);
    setError("");
  }

  const dialogs = (
    <>
      <AlertDialog open={confirming === "archive"} onOpenChange={closeOnDismiss}>
        <AlertDialogContent data-archive-id={entry.id}>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive “{entry.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Archiving stops running this remixlet, hides it in config and stops future chats seeing and editing it. It
              can be restored at a later date.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p className="action-error text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel data-action="cancel-archive">Cancel</AlertDialogCancel>
            <Button
              type="button"
              data-action="confirm-archive"
              disabled={busy}
              onClick={() =>
                run(async () => void (await send({ kind: "remixlet.remove", id: entry.id, reloadMatching: true }, "remixlet.entry")))
              }
            >
              <Archive data-icon="inline-start" />
              Archive
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirming === "destroy"} onOpenChange={closeOnDismiss}>
        <AlertDialogContent data-destroy-id={entry.id}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{entry.name}” forever?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the remixlet, its entire version history, and every capability it was granted.
              This action is irreversible — unlike archiving, there is no way to restore it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p className="action-error text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel data-action="cancel-destroy">Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              data-action="confirm-destroy"
              disabled={busy}
              onClick={() =>
                run(
                  async () => void (await send({ kind: "remixlet.destroy", id: entry.id, reloadMatching: true }, "remixlet.destroyed")),
                  leaveIfViewing,
                )
              }
            >
              <Trash2 data-icon="inline-start" />
              {busy ? "Deleting forever…" : "Delete forever"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

  return { actions, busy, dialogs };
}

// Base UI's context menu re-exports the plain menu's item, so the two item
// components differ only in the wrapper they expect around them — hence one
// small renderer per menu flavour rather than one generic over both.
function DropdownItems({ actions, busy }: { actions: LifecycleAction[]; busy: boolean }) {
  return actions.map((action) => (
    <DropdownMenuItem
      key={action.key}
      data-action={action.key}
      disabled={busy}
      variant={action.destructive ? "destructive" : "default"}
      onClick={action.onSelect}
    >
      <action.icon aria-hidden />
      {action.label}
    </DropdownMenuItem>
  ));
}

function ContextItems({ actions, busy }: { actions: LifecycleAction[]; busy: boolean }) {
  return actions.map((action) => (
    <ContextMenuItem
      key={action.key}
      data-action={action.key}
      disabled={busy}
      variant={action.destructive ? "destructive" : "default"}
      onClick={action.onSelect}
    >
      <action.icon aria-hidden />
      {action.label}
    </ContextMenuItem>
  ));
}

/** The ⋯ dropdown that sits beside a remixlet's title on its own page. */
export function RemixletActionsMenu({
  entry,
  onChanged,
  className,
}: {
  entry: RegistryEntry;
  onChanged: () => Promise<void>;
  className?: string;
}) {
  const { actions, busy, dialogs } = useLifecycle(entry, onChanged);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          data-action="remixlet-menu"
          aria-label={`Actions for ${entry.name}`}
          className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "text-muted-foreground", className)}
        >
          <EllipsisVertical aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent data-menu-id={entry.id} align="start" className="w-auto min-w-36">
          <DropdownItems actions={actions} busy={busy} />
        </DropdownMenuContent>
      </DropdownMenu>
      {dialogs}
    </>
  );
}


/**
 * A sidebar row's two doors onto the same actions: right-click anywhere on the
 * row, or click the ⋯ that fades in on hover. One lifecycle instance backs
 * both, so there is only ever one set of dialogs per row.
 *
 * The row itself — not the link inside it — is the right-click surface, so the
 * ⋯ button can sit beside the link instead of illegally inside the anchor.
 */
export function RemixletRowMenu({
  entry,
  onChanged,
  className,
  children,
}: {
  entry: RegistryEntry;
  onChanged: () => Promise<void>;
  /** Row styling, including the hover/active highlight the ⋯ fades in over. */
  className?: string;
  children: ReactNode;
}) {
  const { actions, busy, dialogs } = useLifecycle(entry, onChanged);
  return (
    <ContextMenu>
      <ContextMenuTrigger data-remixlet-row={entry.id} className={cn("group/row flex items-center", className)}>
        {children}
        <DropdownMenu>
          <DropdownMenuTrigger
            data-action="remixlet-menu"
            aria-label={`Actions for ${entry.name}`}
            className={cn(
              buttonVariants({ variant: "ghost", size: "icon-xs" }),
              // Invisible until the row is hovered, the button is keyboard
              // focused, or its menu is open — but always laid out, so rows
              // never reflow as the pointer moves down the list.
              "mr-1 shrink-0 text-muted-foreground opacity-0 transition-opacity",
              "group-hover/row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100",
            )}
          >
            <EllipsisVertical aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent data-menu-id={entry.id} align="end" className="w-auto min-w-36">
            <DropdownItems actions={actions} busy={busy} />
          </DropdownMenuContent>
        </DropdownMenu>
      </ContextMenuTrigger>
      <ContextMenuContent data-menu-id={entry.id} className="min-w-36">
        <ContextItems actions={actions} busy={busy} />
      </ContextMenuContent>
      {dialogs}
    </ContextMenu>
  );
}
