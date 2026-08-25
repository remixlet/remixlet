// Providers section of the settings page: connect model providers (API key or
// ChatGPT subscription), refresh their model lists, and manage credentials.
// The catalog itself lives in useProviderCatalog — shared with the welcome
// page's connect step — so this file is only the settings-page layout over
// it. Provider API keys stay panel-local (read/written via ext.storage from
// this page) — they never move through the worker or bridge.

import { useState } from "react";
import { Check, Loader2, Plus, X } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import { AddProviderForm } from "../provider-settings/add-provider-form.js";
import { ProviderList } from "../provider-settings/provider-list.js";
import { useProviderCatalog } from "../provider-settings/use-provider-catalog.js";

export function ProvidersPage() {
  const catalog = useProviderCatalog();
  const [adding, setAdding] = useState(false);

  if (!catalog.loaded) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading providers…
      </div>
    );
  }

  const hasProviders = catalog.settings.providers.length > 0;
  const showAddForm = adding || !hasProviders;

  return (
    <div id="providers-page" className="flex flex-col gap-5">
      <header className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">Model providers</h2>
          <p className="max-w-xl text-sm text-muted-foreground">
            {showAddForm
              ? "Connect a provider to make its models available in chat. It takes about a minute."
              : "Remixlet needs access to an AI model only to build new remixlets; once they exist - they run indefinitely without consuming more model usage."}
          </p>
        </div>
        {!showAddForm && (
          <Button
            id="add-provider"
            type="button"
            size="sm"
            className="shrink-0"
            onClick={() => {
              setAdding(true);
              catalog.clearMessages();
            }}
          >
            <Plus />
            Add provider
          </Button>
        )}
      </header>

      {catalog.error && (
        <Alert variant="destructive">
          <X />
          <AlertTitle>Couldn’t connect</AlertTitle>
          <AlertDescription>{catalog.error}</AlertDescription>
        </Alert>
      )}
      {catalog.status && (
        <Alert>
          <Check />
          <AlertTitle>Provider settings updated</AlertTitle>
          <AlertDescription>{catalog.status}</AlertDescription>
        </Alert>
      )}

      {showAddForm ? (
        <AddProviderForm
          firstProvider={!hasProviders}
          busy={catalog.busy}
          codexStatus={catalog.codexStatus}
          onConnect={(draft) =>
            catalog.addProvider(draft).then((connected) => {
              if (connected) setAdding(false);
              return connected;
            })
          }
          onCancel={
            hasProviders
              ? () => {
                  setAdding(false);
                  catalog.clearMessages();
                }
              : undefined
          }
          onBeginCodexSignIn={catalog.beginCodexSignIn}
          onSignOutCodex={catalog.signOutCodex}
        />
      ) : (
        <ProviderList
          providers={catalog.settings.providers}
          busyProviderId={catalog.busyProviderId}
          onRefresh={catalog.refreshModels}
          onUpdate={catalog.updateProvider}
          onRemove={catalog.removeProvider}
        />
      )}
    </div>
  );
}
