// Shared visual language for the on-page overlay content scripts
// (annotate-host-content.ts, show-changes-host-content.ts): the Remixlet dark
// design tokens from the design handoff, the private Space Grotesk font
// registration, and the inline-SVG icon helper. One source of truth so the
// overlays stay one visual vocabulary — a mark box looks the same whether the
// user drew it (annotate mode) or a remixlet's verification earned it (show
// what it changed).
//
// Each content script bundles its own copy (separate esbuild entry points),
// so module state here (fontsRequested) is per-script — that matches the
// per-script injection lifecycle and needs no coordination.

// ---- design tokens (Remixlet dark — final, from the design handoff) --------
export const ACCENT = "#3ec98f";
export const ACCENT_INK = "#0b241a";
export const SURFACE = "#1d211f";
export const SURFACE_2 = "#262b28";
export const INPUT_BG = "#131315";
export const INK = "#e9e6db";
export const MUTED = "#a5aea4";
export const DISABLED = "#565e56";
export const RING = "0 0 0 1px rgba(233,230,219,.14)";
export const SHADOW = "0 1px 2px rgba(0,0,0,.35), 0 14px 36px -20px rgba(0,0,0,.6)";
export const HALO = "rgba(8,10,9,.55)";
export const FONT = "'Remixlet Space Grotesk', 'Space Grotesk', system-ui, sans-serif";

// ---- fonts -----------------------------------------------------------------

// The overlays never inherit the host page's font: Space Grotesk ships with
// the extension (fontsource variable subsets, also used by the panel) and is
// registered under a private family name so a page's own "Space Grotesk"
// cannot collide. The bytes are fetched here in the ISOLATED world (extension
// privileges — the page's font-src CSP does not apply) and handed to FontFace
// as a buffer, which never triggers a CSP-governed document fetch; a URL-based
// FontFace would be blocked on strict-CSP pages and drop the overlays to
// system-ui while the panel kept Space Grotesk. Failures still fall back to
// system-ui via the FONT stack.
let fontsRequested = false;
export function ensureFonts(): void {
  if (fontsRequested) return;
  fontsRequested = true;
  const subsets: Array<[file: string, unicodeRange: string]> = [
    [
      "space-grotesk-latin-wght-normal.woff2",
      "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
    ],
    [
      "space-grotesk-latin-ext-wght-normal.woff2",
      "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
    ],
    [
      "space-grotesk-vietnamese-wght-normal.woff2",
      "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB",
    ],
  ];
  for (const [file, unicodeRange] of subsets) {
    void (async () => {
      try {
        const url = chrome.runtime.getURL(`panel/files/${file}`);
        const response = await fetch(url);
        if (!response.ok) return;
        const bytes = await response.arrayBuffer();
        const face = new FontFace("Remixlet Space Grotesk", bytes, {
          weight: "300 700",
          unicodeRange,
        });
        document.fonts.add(face);
      } catch {
        // Fall back to the system stack.
      }
    })();
  }
}

// ---- svg helpers -----------------------------------------------------------

export const SVG_NS = "http://www.w3.org/2000/svg";

/** Lucide-style 2px-stroke icon as an inline SVG element. */
export function icon(paths: string, size: number, stroke = "currentColor", strokeWidth = 2): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", stroke);
  svg.setAttribute("stroke-width", String(strokeWidth));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.innerHTML = paths;
  return svg;
}

export const PENCIL_PATHS = '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path>';
export const ARROW_RIGHT_PATHS = '<path d="M5 12h13"></path><path d="M13 6l6 6-6 6"></path>';
export const TRASH_PATHS =
  '<path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>';
export const UNDO_PATHS = '<path d="M9 14 4 9l5-5"></path><path d="M4 9h10a6 6 0 0 1 0 12h-3"></path>';
export const BOX_PATHS = '<rect x="4" y="5" width="16" height="14" rx="2"></rect>';
export const CHECK_PATHS = '<path d="M20 6 9 17l-5-5"></path>';
