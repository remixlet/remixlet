import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

class FakeEvent {
  listeners = new Set();
  addListener(listener) { this.listeners.add(listener); }
  removeListener(listener) { this.listeners.delete(listener); }
  emit(details) { for (const listener of [...this.listeners]) listener(details); }
}

export async function assertPageAssetFetchBoundary() {
  const redirects = new FakeEvent();
  globalThis.chrome = {
    runtime: { getURL: (value) => `chrome-extension://asset-contract/${value}` },
    webRequest: { onBeforeRedirect: redirects },
  };
  delete globalThis.browser;

  const result = await esbuild.build({
    stdin: {
      contents:
        'export { fetchPageHtml, fetchPageIcon, fetchProbeStylesheet } from "./src/platform/privileged-fetch.ts";',
      resolveDir: repoRoot,
      sourcefile: "page-asset-fetch-contract.ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    define: { __BROWSER_TARGET__: '"chrome"' },
  });
  const source = result.outputFiles[0].text;
  const contract = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

  const requested = [];
  let route = async (url) => new Response("ok", { status: 200 });
  globalThis.fetch = async (url, options) => {
    const href = new URL(String(url)).href;
    requested.push(href);
    return route(href, options);
  };

  for (const href of [
    "http://127.0.0.1:43199/audit",
    "https://cdn.example/icon.png",
    "https://private.invalid/theme.css",
    "https://page.example:444/icon.png",
  ]) {
    requested.length = 0;
    await assert.rejects(() => contract.fetchPageIcon(href, "https://page.example"), /outside the page origin/);
    assert.deepEqual(requested, [], `cross-origin request was stopped before fetch: ${href}`);
  }

  requested.length = 0;
  route = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
  const icon = await contract.fetchPageIcon("https://page.example:443/icon.png", "https://page.example");
  assert.deepEqual([...icon.bytes], [1, 2, 3], "same-origin icon bytes returned");
  assert.deepEqual(requested, ["https://page.example/icon.png"], "default ports normalize to one exact origin");

  requested.length = 0;
  route = async (href) => {
    if (href.endsWith("/redirect")) {
      queueMicrotask(() => redirects.emit({
        url: href,
        method: "GET",
        redirectUrl: "https://cdn.example/stolen.png",
        statusCode: 302,
      }));
      throw new TypeError("redirect blocked");
    }
    return new Response(new Uint8Array([9]), { status: 200, headers: { "content-type": "image/png" } });
  };
  await assert.rejects(
    () => contract.fetchPageIcon("https://page.example/redirect", "https://page.example"),
    /redirect escaped the page origin/,
  );
  assert.deepEqual(requested, ["https://page.example/redirect"], "cross-origin redirect target was never requested");

  requested.length = 0;
  route = async (href) => {
    if (href.endsWith("/redirect")) {
      queueMicrotask(() => redirects.emit({
        url: href,
        method: "GET",
        redirectUrl: "https://page.example/final.png",
        statusCode: 302,
      }));
      throw new TypeError("redirect blocked");
    }
    return new Response(new Uint8Array([7]), { status: 200, headers: { "content-type": "image/png" } });
  };
  const redirected = await contract.fetchPageIcon("https://page.example/redirect", "https://page.example");
  assert.deepEqual([...redirected.bytes], [7], "same-origin redirect completes");
  assert.deepEqual(
    requested,
    ["https://page.example/redirect", "https://page.example/final.png"],
    "only same-origin redirect hops were requested",
  );

  requested.length = 0;
  route = async () => new Response('@import "https://cdn.example/import.css"; .x{}', {
    status: 200,
    headers: { "content-type": "text/css" },
  });
  const css = await contract.fetchProbeStylesheet("https://page.example/main.css", "https://page.example");
  assert.match(css, /@import/, "same-origin stylesheet returned");
  await assert.rejects(
    () => contract.fetchProbeStylesheet("https://cdn.example/import.css", "https://page.example"),
    /outside the page origin/,
  );
  assert.deepEqual(requested, ["https://page.example/main.css"], "cross-origin CSS import target was never requested");

  requested.length = 0;
  let cancelled = false;
  let pulls = 0;
  route = async () => new Response(new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(64 * 1024));
    },
    cancel() { cancelled = true; },
  }), { status: 200, headers: { "content-type": "image/png" } });
  await assert.rejects(
    () => contract.fetchPageIcon("https://page.example/endless.png", "https://page.example"),
    /exceeds 262144 bytes/,
  );
  assert(cancelled, "the endless icon stream was cancelled at the cap");
  assert(pulls <= 6, `the reader stopped near the cap instead of buffering forever: ${pulls} pulls`);

  requested.length = 0;
  cancelled = false;
  pulls = 0;
  route = async () => new Response(new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() { cancelled = true; },
  }), { status: 200, headers: { "content-type": "image/png", "content-length": String(512 * 1024) } });
  await assert.rejects(
    () => contract.fetchPageIcon("https://page.example/oversized.png", "https://page.example"),
    /exceeds 262144 bytes/,
  );
  assert(cancelled, "a declared oversized icon body was cancelled");
  assert(pulls <= 1, `the declared oversized icon body was cancelled before consumer reads: ${pulls} eager pulls`);

  requested.length = 0;
  route = async () => new Response('<head><link rel="icon" sizes="128x128" href="/icon.png"></head>', {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  const html = await contract.fetchPageHtml("https://page.example");
  assert.match(html.content, /icon\.png/, "same-origin HTML discovery still works");
  assert.deepEqual(requested, ["https://page.example/"], "HTML discovery stays on the page origin");
}
