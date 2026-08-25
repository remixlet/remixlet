// Hash router for the control center SPA (manager.html). Routes are plain
// location.hash paths so every page is deep-linkable from the worker, popup,
// and panel (e.g. manager.html#/settings/providers) without any history API
// plumbing.
// First-run setup is NOT a route here — it is its own document
// (welcome.html), because the control center does not open until it is done.

import { useEffect, useState } from "react";

/** Sections of the settings page; each is its own hash so both are deep-linkable. */
export type SettingsSection = "general" | "providers";

export type Route =
  | { kind: "overview" }
  | { kind: "settings"; section: SettingsSection }
  | { kind: "remixlet"; id: string }
  | { kind: "conversations" }
  | { kind: "conversation"; id: string };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "");
  // Providers used to be a top-level page; the old hash keeps working for
  // stored deep links and lands on its new home under settings.
  if (path === "/providers" || path === "/settings/providers") return { kind: "settings", section: "providers" };
  if (path === "/settings") return { kind: "settings", section: "general" };
  if (path === "/conversations") return { kind: "conversations" };
  const conversation = /^\/conversations\/(.+)$/.exec(path);
  if (conversation) return { kind: "conversation", id: decodeURIComponent(conversation[1]!) };
  const remixlet = /^\/remixlets\/(.+)$/.exec(path);
  if (remixlet) return { kind: "remixlet", id: decodeURIComponent(remixlet[1]!) };
  return { kind: "overview" };
}

export function routeHash(route: Route): string {
  switch (route.kind) {
    case "overview":
      return "#/";
    case "settings":
      return route.section === "providers" ? "#/settings/providers" : "#/settings";
    case "remixlet":
      return `#/remixlets/${encodeURIComponent(route.id)}`;
    case "conversations":
      return "#/conversations";
    case "conversation":
      return `#/conversations/${encodeURIComponent(route.id)}`;
  }
}

export function navigate(route: Route): void {
  location.hash = routeHash(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const onHashChange = (): void => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return route;
}
