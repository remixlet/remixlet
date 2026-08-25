// The rmx.* capability API injected ahead of every remixlet's own scripts
// (wiki/handoff.md §5 "Capability bridge"). Runs in the USER_SCRIPT world; transport
// is the world's runtime messaging; the WORKER enforces grants — this code is
// convenience, not authority.
//
// Each remixlet has a distinct USER_SCRIPT world. Chrome's MessageSender does
// not expose that worldId, so attribution uses a bearer token injected only
// into that isolated world and checked by the worker on the dedicated
// runtime.onUserScriptMessage channel.
//
// `watch` is a long-poll: the worker parks the response until the key's
// revision moves (or a ~20s timeout). A dying service worker just drops the
// channel; the bridge re-polls. Cheap, and survives MV3 lifecycle.
//
// CONTRACT DISCIPLINE. At launch the rmx.* API becomes a published contract:
// every stored remixlet was written against the bridge that existed when
// write_remixlet saved it, and that code cannot be regenerated when the API
// changes — it just fails at runtime, on the user's page, with no build step
// in between to catch it. So:
//   - Post-launch, change the API by ADDING only. New methods and new fields
//     are fine; renaming, removing, or changing the observable behavior of
//     anything an existing remixlet can call is a breaking change.
//   - A breaking change bumps RMX_BRIDGE_VERSION (shared/bridge-version.ts),
//     raises RMX_BRIDGE_MIN_SUPPORTED if old remixlets truly cannot run
//     anymore, and extends the skew handling (worker/activation.ts computes
//     it; skewed remixlets get the needs-repair treatment instead of being
//     injected) so affected remixlets fail visibly, never silently.
//   - Pre-launch, change the API freely under its final names — no
//     `experimental` prefixes, no compatibility shims. The version bump above
//     still applies, so locally stored remixlets surface as needs-repair
//     instead of misbehaving.

import { urlActivePredicateCode } from "./gate.js";
import { MUTATION_OBSERVER_FEEDBACK_LOOP_PREFIX, MUTATION_OBSERVER_THROTTLE_NOTICE_PREFIX } from "../shared/script-log.js";

export interface GatedUserScriptOptions {
  remixletId: string;
  bridgeToken: string;
  /** The manifest's REAL matches — registration is origin-wide (injection.ts). */
  matches: readonly string[];
  files: { code: string }[];
}

/**
 * Wrap a remixlet's USER_SCRIPT files in the runtime URL gate: files run when
 * the page URL first satisfies the manifest matches — at document load, or
 * later when a client-side navigation carries the page into them (signalled
 * through rmx.navigation, which the bridge sets up just before this runs).
 * Files run at most once per document; navigating away does not (cannot)
 * unload them — remixlet code reacts to that via rmx.navigation.onChange.
 */
export function gatedUserScriptCode(options: GatedUserScriptOptions): string {
  const files = options.files
    .map(
      (file) =>
        `  try { (function () {\n${file.code}\n}).call(undefined); } catch (error) { reportError("script failed: " + String(error)); }`,
    )
    .join("\n");
  return `(() => {
  const urlActive = ${urlActivePredicateCode(options.matches)};
  const reportError = (message) => {
    const text = String(message).slice(0, 500);
    try { console.error("[remixlet] " + text); } catch {}
    try {
      void chrome.runtime.sendMessage({
        remixletId: ${JSON.stringify(options.remixletId)},
        bridgeToken: ${JSON.stringify(options.bridgeToken)},
        kind: "rmx.log", level: "error", message: text,
      }).catch(() => {});
    } catch {}
  };
  let activated = false;
  const runFiles = () => {
    activated = true;
    // Usage telemetry: one fire-and-forget ping per activation (per document,
    // plus per SPA navigation into a matching URL). The worker aggregates it
    // into the dashboard's per-day counters; failure changes nothing here.
    try {
      void chrome.runtime.sendMessage({
        remixletId: ${JSON.stringify(options.remixletId)},
        bridgeToken: ${JSON.stringify(options.bridgeToken)},
        kind: "rmx.run",
      }).catch(() => {});
    } catch {}
${files}
  };
  const tryActivate = () => { if (!activated && urlActive(location.href)) runFiles(); };
  rmx.navigation.onChange(() => tryActivate());
  tryActivate();
})();`;
}

export function bridgeCode(remixletId: string, bridgeToken: string, relayToken = ""): string {
  return `(() => {
  const remixletId = ${JSON.stringify(remixletId)};
  // Native console methods, captured before the console-capture wrappers below
  // replace them: bridge-internal errors may print without re-entering the
  // capture path. Contained observer warnings stay in the agent log only so
  // Chrome does not mispresent normal guard operation as an extension error.
  const nativeConsole = {};
  for (const level of ["log", "info", "warn", "error"]) {
    const method = console[level];
    nativeConsole[level] = (...args) => { try { method.apply(console, args); } catch {} };
  }
  // Runaway-observer guard. Agent-written scripts are prone to one specific
  // fatal bug: a MutationObserver callback that writes to the DOM
  // unconditionally (textContent, setAttribute, ...) retriggers itself in an
  // unbounded microtask chain — the event loop never runs again, the tab
  // freezes, and every kill switch (popup toggle, rollback) becomes
  // unreachable. This world's MutationObserver is therefore budgeted: past
  // BUDGET callback runs per WINDOW_MS, deliveries coalesce into one trailing
  // run per window. Well-behaved observers never notice; a feedback loop
  // degrades to a warning and a throttled steady state instead of a hang.
  //
  // Exceeding the budget is REPORTED by cause, not treated as one condition.
  // Each observer delivery is one microtask checkpoint, so a self-feeding
  // chain (run → write → next delivery) burns the whole budget in a few
  // milliseconds and does so again immediately after every coalesced trailing
  // run. Page-driven churn arrives as independent tasks spread across the
  // window. Fast saturation in consecutive windows ⇒ feedback-loop warning
  // (blocks verification); slow saturation ⇒ one informational throttle
  // notice (a busy page being coalesced is normal operation, not a defect).
  const NativeMutationObserver = globalThis.MutationObserver;
  if (NativeMutationObserver && !NativeMutationObserver.__rmxObserverGuard) {
    const BUDGET = 40;
    const WINDOW_MS = 1000;
    const FAST_SATURATION_MS = 250;
    const GuardedMutationObserver = class MutationObserver extends NativeMutationObserver {
      constructor(callback) {
        let windowStart = 0;
        let calls = 0;
        let trailingScheduled = false;
        let lastFastSaturationAt = 0;
        let warnedLoop = false;
        let notedThrottle = false;
        super(function (records, observer) {
          const now = Date.now();
          if (now - windowStart >= WINDOW_MS) {
            windowStart = now;
            calls = 0;
          }
          calls += 1;
          if (calls <= BUDGET) {
            callback.call(this, records, observer);
            return;
          }
          if (calls === BUDGET + 1) {
            // Classify once per window, at the moment the budget runs out.
            // report is declared later in this IIFE but is initialized long
            // before any observer callback can fire.
            const fastSaturation = now - windowStart < FAST_SATURATION_MS;
            if (fastSaturation && lastFastSaturationAt !== 0 && now - lastFastSaturationAt <= WINDOW_MS * 2) {
              if (!warnedLoop) {
                warnedLoop = true;
                report(
                  "warn",
                  ${JSON.stringify(MUTATION_OBSERVER_FEEDBACK_LOOP_PREFIX)} + BUDGET + " times in under " +
                    FAST_SATURATION_MS + "ms in consecutive " + WINDOW_MS + "ms windows — likely a feedback loop " +
                    "(each run's DOM write triggers the next run). Deliveries stay coalesced so the page cannot " +
                    "freeze; make the callback idempotent: only write when the value actually changes.",
                  false,
                );
              }
            } else if (!fastSaturation && !warnedLoop && !notedThrottle) {
              notedThrottle = true;
              report(
                "info",
                ${JSON.stringify(MUTATION_OBSERVER_THROTTLE_NOTICE_PREFIX)} + BUDGET + " per " + WINDOW_MS +
                  "ms — this page mutates its own DOM heavily. Deliveries are coalesced to one trailing run per " +
                  "window, so reactions to rapid page updates may lag by up to a second. This is throttling on a " +
                  "busy page, not a feedback loop; the callback does not need fixing.",
                false,
              );
            }
            lastFastSaturationAt = fastSaturation ? now : 0;
          }
          if (trailingScheduled) return;
          trailingScheduled = true;
          setTimeout(() => {
            trailingScheduled = false;
            windowStart = Date.now();
            calls = 1;
            callback.call(observer, observer.takeRecords(), observer);
          }, WINDOW_MS);
        });
      }
    };
    GuardedMutationObserver.__rmxObserverGuard = true;
    globalThis.MutationObserver = GuardedMutationObserver;
  }
  const bridgeToken = ${JSON.stringify(bridgeToken)};
  const relayToken = ${JSON.stringify(relayToken)};
  const send = (message) =>
    chrome.runtime.sendMessage(Object.assign({ remixletId, bridgeToken }, message));
  // Fire-and-forget error/warning reporting through the rmx.log bridge lane
  // (the worker keeps a bounded per-remixlet ring that the panel's
  // read_remixlet_logs tool reads). Runtime errors also mirror to the native
  // console for humans; a caller may suppress that duplicate for a contained,
  // actionable warning. Telemetry, not authority.
  const report = (level, message, mirrorToConsole = true) => {
    const text = String(message).slice(0, 500);
    if (mirrorToConsole) nativeConsole[level === "warn" ? "warn" : "error"]("[remixlet] " + text);
    try { void send({ kind: "rmx.log", level, message: text }).catch(() => {}); } catch {}
  };
  // Console capture. This world's console binding is the remixlet's alone —
  // the host page logs through the MAIN world's separate console object — so
  // wrapping it here records exactly the remixlet's own output and never the
  // page's noise. Native behavior is preserved (calls still print); each line
  // is additionally forwarded to the same bounded per-remixlet log the agent
  // reads back with read_remixlet_logs, which is what makes console.log
  // debugging visible to a fix turn at all. Bounded twice: 500 chars per line
  // (the worker clamps again) and CONSOLE_FORWARD_CAP lines per document, so
  // a per-mutation logger degrades to a capped record instead of a message
  // flood — the last slot becomes a warning naming the cutoff.
  const CONSOLE_FORWARD_CAP = 100;
  let consoleForwarded = 0;
  const serializeConsoleArg = (value) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return String(value);
    try {
      const json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    } catch { return String(value); }
  };
  const forwardConsole = (level, args) => {
    let text;
    try { text = args.map(serializeConsoleArg).join(" ").slice(0, 500); } catch { text = "[unserializable console arguments]"; }
    // "[remixlet] " lines are the bridge's own prints (report above, the URL
    // gate's reportError) — each already sends its own rmx.log message, so
    // forwarding them again would double every entry.
    if (text.lastIndexOf("[remixlet] ", 0) === 0) return;
    if (consoleForwarded >= CONSOLE_FORWARD_CAP) return;
    consoleForwarded += 1;
    if (consoleForwarded === CONSOLE_FORWARD_CAP) {
      report("warn", "console capture stopped: more than " + CONSOLE_FORWARD_CAP +
        " console lines this page load — further console output is not recorded");
      return;
    }
    try { void send({ kind: "rmx.log", level, message: text }).catch(() => {}); } catch {}
  };
  // Marker guards double-wrapping if the bridge is ever injected twice into
  // one world (mirrors the observer guard's __rmxObserverGuard).
  if (!console.__rmxConsoleCapture) {
    for (const level of ["log", "info", "warn", "error"]) {
      console[level] = (...args) => {
        nativeConsole[level](...args);
        forwardConsole(level, args);
      };
    }
    try { Object.defineProperty(console, "__rmxConsoleCapture", { value: true }); } catch {}
  }
  const storageCall = (op, payload) =>
    send(Object.assign({ kind: "rmx.storage", op }, payload));
  const notificationsCall = (op, payload) =>
    send(Object.assign({ kind: "rmx.notifications", op }, payload));
  const clipboardCall = (payload) =>
    send(Object.assign({ kind: "rmx.clipboard", op: "writeText" }, payload));
  const menuCall = (op, payload = {}) =>
    send(Object.assign({ kind: "rmx.menu", op }, payload));
  const scheduleCall = (op, payload = {}) =>
    send(Object.assign({ kind: "rmx.schedule", op }, payload));
  const unwrap = async (promise) => {
    const reply = await promise;
    if (!reply || reply.ok !== true) throw new Error((reply && reply.error) || "rmx bridge failure");
    return reply;
  };
  // MAIN → USER_SCRIPT relay consumer. The MAIN side (extension-authored
  // relay/interceptor, or the remixlet's own MAIN files via rmxRelay.post)
  // dispatches CustomEvents on the shared DOM; everything arriving here is
  // untrusted page data. Registering a listener also asks the MAIN side to
  // replay its ring buffer (per-entry seq numbers make the replay idempotent
  // for consumers that dedupe, as rmx.network.onResponse does).
  const relayListeners = new Map();
  let relayAttached = false;
  const relaySync = () => {
    try { document.dispatchEvent(new CustomEvent("rmx-relay-sync:" + relayToken)); } catch {}
  };
  const relayOn = (topic, callback) => {
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    if (!relayAttached) {
      relayAttached = true;
      document.addEventListener("rmx-relay:" + relayToken, (event) => {
        let message;
        try { message = JSON.parse(String(event.detail)); } catch { return; }
        if (!message || typeof message.topic !== "string") return;
        const set = relayListeners.get(message.topic);
        if (!set) return;
        for (const listener of [...set]) {
          try { listener(message.data); } catch (error) { report("error", "relay callback failed: " + String(error)); }
        }
      });
    }
    const set = relayListeners.get(topic) || new Set();
    set.add(callback);
    relayListeners.set(topic, set);
    relaySync();
    return () => set.delete(callback);
  };
  // SPA navigation hub. Registration matches are origin-wide (see
  // worker/injection.ts) so both the activation gate and remixlet
  // route-change reactions hang off this. Signals: popstate/hashchange fire
  // in this world natively; pushState/replaceState are visible only to the
  // MAIN-world watcher (relay.ts), which posts navigation:change over the
  // relay. Every signal is treated as a hint, never data: the hub re-reads
  // location.href itself and notifies only on a real change, so a page
  // forging relay events can at most trigger a harmless re-check.
  const navListeners = new Set();
  let navUrl = location.href;
  const navCheck = () => {
    const url = location.href;
    if (url === navUrl) return;
    const previousUrl = navUrl;
    navUrl = url;
    for (const listener of [...navListeners]) {
      try { listener({ url, previousUrl }); } catch (error) { report("error", "navigation callback failed: " + String(error)); }
    }
  };
  window.addEventListener("popstate", () => navCheck());
  window.addEventListener("hashchange", () => navCheck());
  relayOn("navigation:change", () => navCheck());
  // rmx.keep — the sanctioned way to keep a page condition true on pages that
  // redraw themselves. The remixlet declares WHAT should hold; the bridge owns
  // the watching, so remixlet code never wires its own watch-and-reapply
  // observer (the loop-prone pattern the runaway guard above contains).
  // Contract — all callbacks synchronous and fast; only apply may write:
  //   when()   optional: is the page piece this feature attaches to present?
  //            Returning false idles the keep without penalty — a page that
  //            has not rendered the anchor yet is not a failure.
  //   ensure() does the desired condition hold right now?
  //   apply()  establish it, synchronously.
  // Evaluation happens at registration, after DOM mutations (one shared,
  // budget-guarded observer for every keep in this world), and on route
  // changes. apply runs only while when() passes and ensure() is false. An
  // apply (or a thrown callback) that leaves ensure() false
  // KEEP_MAX_FAILED_APPLIES consecutive times halts the keep with a logged
  // reason instead of retrying forever. Frequent SUCCESSFUL reapplies are the
  // job, not a defect (React-style sites revert foreign DOM edits on every
  // render): those log one informational notice and continue.
  const KEEP_MAX_FAILED_APPLIES = 3;
  const KEEP_NOTICE_APPLIES = 25;
  const KEEP_NOTICE_WINDOW_MS = 60000;
  const keeps = new Set();
  let keepObserver = null;
  const evaluateKeep = (keep) => {
    if (keep.halted) return;
    try {
      if (keep.when && !keep.when()) {
        keep.failedApplies = 0;
        return;
      }
      if (keep.ensure()) {
        keep.failedApplies = 0;
        return;
      }
      const now = Date.now();
      if (now - keep.applyWindowStart > KEEP_NOTICE_WINDOW_MS) {
        keep.applyWindowStart = now;
        keep.appliesInWindow = 0;
      }
      keep.appliesInWindow += 1;
      keep.apply();
      if (keep.ensure()) {
        keep.failedApplies = 0;
        if (keep.appliesInWindow >= KEEP_NOTICE_APPLIES && !keep.notedFrequentReapply) {
          keep.notedFrequentReapply = true;
          report("info", 'keep "' + keep.label + '": reapplied ' + keep.appliesInWindow +
            " times in the last minute — the page redraws this area often. Reapplying is normal; informational only.", false);
        }
        return;
      }
      keep.failedApplies += 1;
      if (keep.failedApplies >= KEEP_MAX_FAILED_APPLIES) {
        keep.halted = true;
        report("error", 'keep "' + keep.label + '" halted: apply() ran ' + KEEP_MAX_FAILED_APPLIES +
          " consecutive times without making ensure() true. Make one apply() establish exactly the state ensure() checks," +
          " or add when() so the keep idles until the page piece it needs exists.");
      }
    } catch (error) {
      keep.failedApplies += 1;
      if (keep.failedApplies >= KEEP_MAX_FAILED_APPLIES) {
        keep.halted = true;
        report("error", 'keep "' + keep.label + '" halted: callbacks threw ' + KEEP_MAX_FAILED_APPLIES +
          " consecutive times — " + String(error));
      } else {
        report("error", 'keep "' + keep.label + '" callback threw: ' + String(error));
      }
    }
  };
  const evaluateKeeps = () => { for (const keep of [...keeps]) evaluateKeep(keep); };
  const registerKeep = (label, spec) => {
    if (typeof label !== "string" || label.trim() === "") {
      throw new TypeError("keep label must be a short plain-words description of the condition");
    }
    if (!spec || typeof spec.ensure !== "function" || typeof spec.apply !== "function") {
      throw new TypeError("keep needs { ensure, apply } functions (plus optional when)");
    }
    if (spec.when !== undefined && typeof spec.when !== "function") {
      throw new TypeError("keep when must be a function when given");
    }
    const keep = {
      label: label.trim().slice(0, 120),
      when: spec.when,
      ensure: spec.ensure,
      apply: spec.apply,
      failedApplies: 0,
      appliesInWindow: 0,
      applyWindowStart: 0,
      notedFrequentReapply: false,
      halted: false,
    };
    keeps.add(keep);
    if (!keepObserver) {
      keepObserver = new MutationObserver(() => evaluateKeeps());
      keepObserver.observe(document.documentElement || document, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      navListeners.add(evaluateKeeps);
    }
    evaluateKeep(keep);
    return () => {
      keeps.delete(keep);
      if (keeps.size === 0 && keepObserver) {
        keepObserver.disconnect();
        keepObserver = null;
        navListeners.delete(evaluateKeeps);
      }
    };
  };
  globalThis.rmx = {
    // Self-reporting for remixlet code (no capability needed — telemetry, not
    // authority): entries land in the per-remixlet script log the agent reads
    // back with read_remixlet_logs. Without this lane, scan failures inside a
    // remixlet's own catch blocks are invisible and the agent debugs blind —
    // report anomalies (a page that parsed zero records, an unexpected
    // response shape) instead of swallowing them.
    log: {
      warn: (message) => report("warn", message),
      error: (message) => report("error", message),
    },
    // Declarative keep-this-true (machinery and contract above). Returns a
    // stop function; halts are reported to the same log lane the agent reads.
    keep: registerKeep,
    relay: { on: relayOn },
    navigation: {
      onChange: (callback) => {
        if (typeof callback !== "function") throw new TypeError("callback must be a function");
        navListeners.add(callback);
        return () => navListeners.delete(callback);
      },
    },
    network: {
      onResponse: (pattern, callback) => {
        if (typeof callback !== "function") throw new TypeError("callback must be a function");
        const wanted = String(pattern || "").toLowerCase();
        const seen = new Set();
        return relayOn("network:response", (data) => {
          try {
            if (!data || typeof data.url !== "string") return;
            if (typeof data.seq === "number") {
              if (seen.has(data.seq)) return;
              seen.add(data.seq);
            }
            let hostname = "";
            try { hostname = new URL(data.url).hostname.toLowerCase(); } catch {}
            const matches =
              wanted === "" ||
              (wanted.startsWith("*.")
                ? hostname === wanted.slice(2) || hostname.endsWith("." + wanted.slice(2))
                : hostname === wanted || data.url.toLowerCase().includes(wanted));
            if (matches) callback(data);
          } catch (error) {
            report("error", "network observer callback failed: " + String(error));
          }
        });
      },
    },
    fetch: async (url, options = {}) => {
      const headers = options.headers === undefined
        ? []
        : Array.from(new Headers(options.headers).entries());
      const reply = await unwrap(send({
        kind: "rmx.fetch",
        request: {
          url: url instanceof URL ? url.href : String(url),
          options: {
            method: options.method,
            headers,
            body: options.body,
            timeoutMs: options.timeoutMs,
          },
        },
      }));
      const response = reply.response;
      const content = response.content;
      return Object.freeze({
        url: response.url,
        status: response.status,
        statusText: response.statusText,
        ok: response.status >= 200 && response.status < 300,
        redirected: response.redirected,
        headers: new Headers(response.headers),
        body: content,
        text: async () => content,
        json: async () => JSON.parse(content),
      });
    },
    storage: {
      get: async (key) => (await unwrap(storageCall("get", { key }))).value,
      set: async (key, value) => { await unwrap(storageCall("set", { key, value })); },
      delete: async (key) => { await unwrap(storageCall("delete", { key })); },
      watch: (key, callback) => {
        let stopped = false;
        let rev = -1;
        (async () => {
          while (!stopped) {
            try {
              const reply = await unwrap(storageCall("watch", { key, sinceRev: rev }));
              if (stopped) break;
              if (rev !== -1 && reply.rev !== rev) callback(reply.value);
              rev = reply.rev;
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
        })();
        return () => { stopped = true; };
      },
    },
    notifications: {
      show: async (title, message) =>
        (await unwrap(notificationsCall("show", { title, message }))).notificationId,
      clear: async (notificationId) =>
        (await unwrap(notificationsCall("clear", { notificationId }))).cleared,
    },
    clipboard: {
      writeText: async (text) => { await unwrap(clipboardCall({ text })); },
    },
    menu: (() => {
      const callbacks = new Map();
      let polling = false;
      const poll = async () => {
        while (polling) {
          try {
            const reply = await unwrap(menuCall("poll"));
            if (reply.active === false) {
              polling = false;
              break;
            }
            if (!reply.invocation) continue;
            const callback = callbacks.get(reply.invocation.commandId);
            try {
              if (callback) await callback();
            } catch (error) {
              report("error", "menu command failed: " + String(error));
            } finally {
              await unwrap(menuCall("ack", { invocationId: reply.invocation.invocationId }));
            }
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      };
      return {
        register: async (id, label, callback) => {
          if (typeof callback !== "function") throw new TypeError("callback must be a function");
          const reply = await unwrap(menuCall("register", { commandId: id, label }));
          callbacks.set(id, callback);
          if (!polling) {
            polling = true;
            void poll();
          }
          return reply.registrationId;
        },
      };
    })(),
    schedule: (() => {
      let consumedHooks;
      const callbacks = new Map();
      const deliveredCallbacks = new WeakSet();
      const consume = async () => {
        if (!consumedHooks) {
          consumedHooks = unwrap(scheduleCall("consumeHooks")).then((reply) => reply.hooks || []);
        }
        return consumedHooks;
      };
      const deliver = async () => {
        const hooks = await consume();
        for (const [name, registered] of callbacks) {
          for (const callback of registered) {
            if (deliveredCallbacks.has(callback)) continue;
            for (const hook of hooks) if (hook === name) await callback({ name });
            deliveredCallbacks.add(callback);
          }
        }
      };
      return {
        register: async (definition) =>
          (await unwrap(scheduleCall("register", { definition }))).schedule,
        at: async (id, at, action) =>
          (await unwrap(scheduleCall("register", { definition: { id, at, action } }))).schedule,
        every: async (id, every, action) =>
          (await unwrap(scheduleCall("register", { definition: { id, every, action } }))).schedule,
        remove: async (scheduleId) =>
          (await unwrap(scheduleCall("remove", { scheduleId }))).cleared,
        list: async () =>
          (await unwrap(scheduleCall("list"))).schedules,
        clear: async () => {
          await unwrap(scheduleCall("clear"));
          consumedHooks = Promise.resolve([]);
        },
        onSiteOpen: async (hookName, callback) => {
          await unwrap(scheduleCall("onSiteOpen", { hookName }));
          if (callback !== undefined) {
            if (typeof callback !== "function") throw new TypeError("callback must be a function");
            const set = callbacks.get(hookName) || new Set();
            set.add(callback);
            callbacks.set(hookName, set);
            await deliver();
            return () => set.delete(callback);
          }
          return hookName;
        },
        removeOnSiteOpen: async (hookName) =>
          (await unwrap(scheduleCall("removeOnSiteOpen", { hookName }))).cleared,
        consumeHooks: async () => [...await consume()],
        onHook: (hookName, callback) => {
          if (typeof callback !== "function") throw new TypeError("callback must be a function");
          const set = callbacks.get(hookName) || new Set();
          set.add(callback);
          callbacks.set(hookName, set);
          void deliver().catch((error) => report("error", "scheduled hook failed: " + String(error)));
          return () => set.delete(callback);
        },
      };
    })(),
  };
})();`;
}
