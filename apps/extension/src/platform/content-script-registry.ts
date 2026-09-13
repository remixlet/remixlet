// Seam over scripting.registerContentScripts and friends: dynamic content
// scripts, the lane the page agent rides (wiki/design/mediated-execution.md,
// Lifecycle 1). Extension-authored files only — the API takes packaged paths,
// never code strings, so remixlet code cannot enter through here. Available
// wherever the scripting permission is (every target); the worker owns which
// registrations exist and reconciles them from storage on every boot.

import { ext } from "./ext.js";

export interface ContentScriptRegistration {
  id: string;
  matches: string[];
  excludeMatches?: string[];
  /** Packaged file paths, relative to the extension root. */
  js: string[];
  runAt?: "document_start" | "document_end" | "document_idle";
  world?: "ISOLATED" | "MAIN";
  allFrames?: boolean;
  persistAcrossSessions?: boolean;
}

export interface ContentScriptRegistry {
  readonly available: boolean;
  getScripts(): Promise<ContentScriptRegistration[]>;
  register(scripts: ContentScriptRegistration[]): Promise<void>;
  update(scripts: ContentScriptRegistration[]): Promise<void>;
  unregister(ids: string[]): Promise<void>;
}

class ScriptingContentScriptRegistry implements ContentScriptRegistry {
  get available(): boolean {
    return ext.scripting?.registerContentScripts !== undefined;
  }

  private get api(): typeof chrome.scripting {
    if (!this.available) throw new Error("The browser scripting API cannot register content scripts here.");
    return ext.scripting;
  }

  async getScripts(): Promise<ContentScriptRegistration[]> {
    const registered = await this.api.getRegisteredContentScripts();
    return registered.map((script) => {
      const registration: ContentScriptRegistration = {
        id: script.id,
        matches: script.matches ?? [],
        js: script.js ?? [],
      };
      if (script.excludeMatches) registration.excludeMatches = script.excludeMatches;
      if (script.runAt) registration.runAt = script.runAt;
      if (script.world) registration.world = script.world;
      if (script.allFrames !== undefined) registration.allFrames = script.allFrames;
      if (script.persistAcrossSessions !== undefined) registration.persistAcrossSessions = script.persistAcrossSessions;
      return registration;
    });
  }

  async register(scripts: ContentScriptRegistration[]): Promise<void> {
    if (scripts.length > 0) await this.api.registerContentScripts(scripts);
  }

  async update(scripts: ContentScriptRegistration[]): Promise<void> {
    if (scripts.length > 0) await this.api.updateContentScripts(scripts);
  }

  async unregister(ids: string[]): Promise<void> {
    if (ids.length > 0) await this.api.unregisterContentScripts({ ids });
  }
}

const registry: ContentScriptRegistry = new ScriptingContentScriptRegistry();

export function contentScriptRegistry(): ContentScriptRegistry {
  return registry;
}
