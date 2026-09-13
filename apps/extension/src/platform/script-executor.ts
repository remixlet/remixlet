// Seam over scripting.executeScript: one-shot injection of PACKAGED code into
// a tab, in the extension's ISOLATED world or the page's MAIN world. Two
// forms and nothing else: a shipped file by path, or a function from this
// bundle that the browser serialises itself and calls with JSON arguments.
// Neither form takes a code string, which is the point (wiki/design/
// mediated-execution-store-policy.md, route (a)): whatever a caller wants to
// pass from the model reaches the page as `args`, a value, never as source.
// Available wherever the scripting permission is (every target), so the
// probes riding it need no per-browser gate; a browser without the API gets
// one plain reason.

import { BROWSER_TARGET, ext } from "./ext.js";
import { platformReason } from "./capability-reasons.js";

export type ScriptWorld = "ISOLATED" | "MAIN";

/** What executeScript's `args` accept: JSON values, nothing else. */
export type ScriptArgument =
  | string
  | number
  | boolean
  | null
  | ScriptArgument[]
  | { [key: string]: ScriptArgument | undefined };

export interface ScriptExecutor {
  /** Cheap and synchronous: the API is here. */
  readonly available: boolean;
  readonly disabledReason?: string;
  /** Run shipped files (paths relative to the extension root) in the tab's top frame. */
  runFiles(tabId: number, files: string[], world?: ScriptWorld): Promise<void>;
  /**
   * Call a function from this bundle in the tab's top frame with JSON
   * arguments and resolve to its (awaited) return value. The browser
   * serialises the function's SOURCE, so it must close over nothing.
   */
  callFunction<Args extends ScriptArgument[], Result>(
    tabId: number,
    func: (...args: Args) => Result | Promise<Result>,
    args: Args,
    world?: ScriptWorld,
  ): Promise<Result | undefined>;
}

/** The one reason, from the shared copy table (capabilities.ts reports it as `pageProbes`). */
export const SCRIPT_EXECUTOR_UNAVAILABLE = platformReason(BROWSER_TARGET, "pageProbes");

class ScriptingExecutor implements ScriptExecutor {
  get available(): boolean {
    return ext.scripting?.executeScript !== undefined;
  }

  get disabledReason(): string | undefined {
    return this.available ? undefined : SCRIPT_EXECUTOR_UNAVAILABLE;
  }

  private get api(): typeof chrome.scripting {
    if (!this.available) throw new Error(SCRIPT_EXECUTOR_UNAVAILABLE);
    return ext.scripting;
  }

  async runFiles(tabId: number, files: string[], world: ScriptWorld = "ISOLATED"): Promise<void> {
    // injectImmediately: probes read the page as it is now, not after
    // document_idle, and the files are guarded so a second run is a no-op.
    await this.api.executeScript({ target: { tabId }, files, world, injectImmediately: true });
  }

  async callFunction<Args extends ScriptArgument[], Result>(
    tabId: number,
    func: (...args: Args) => Result | Promise<Result>,
    args: Args,
    world: ScriptWorld = "ISOLATED",
  ): Promise<Result | undefined> {
    const [injection] = await this.api.executeScript({ target: { tabId }, func, args, world, injectImmediately: true });
    // SAFETY: the browser resolves the function's returned promise before reporting its result.
    return injection?.result as Result | undefined;
  }
}

const executor: ScriptExecutor = new ScriptingExecutor();

export function scriptExecutor(): ScriptExecutor {
  return executor;
}
