const RESTRICTED_NAMES = new Set(["browser", "chrome"]);

function isErasedTypeReference(reference) {
  if (reference.isTypeReference && !reference.isValueReference) return true;

  // TypeScript's scope manager marks `typeof chrome.runtime` as both a type
  // and value reference because a type query describes a value. It is still
  // erased output, which is the boundary this temporary exception cares
  // about. Qualified namespace types have the same AST shape.
  for (let node = reference.identifier.parent; node; node = node.parent) {
    if (node.type === "TSTypeQuery" || node.type === "TSQualifiedName") return true;
    if (
      node.type === "TSAsExpression" ||
      node.type === "TSTypeAssertion" ||
      node.type === "TSNonNullExpression" ||
      node.type === "TSSatisfiesExpression"
    ) {
      return false;
    }
  }
  return false;
}

/**
 * Keep raw WebExtension globals behind src/platform/.
 *
 * @type {import("eslint").Rule.RuleModule}
 */
export const noRuntimeExtensionApi = {
  meta: {
    type: "problem",
    docs: {
      description: "forbid runtime extension API globals outside the platform layer",
    },
    messages: {
      restricted:
        "Runtime '{{name}}' extension API access belongs in src/platform/. Import the platform abstraction instead.",
    },
    schema: [],
  },
  create(context) {
    return {
      "Program:exit"(node) {
        const globalScope = context.sourceCode.getScope(node);
        for (const reference of globalScope.through) {
          const { identifier } = reference;
          if (!RESTRICTED_NAMES.has(identifier.name)) continue;

          // Namespace references used only by TypeScript are erased at runtime
          // and remain temporarily allowed by wiki/plan.md §1.
          if (isErasedTypeReference(reference)) continue;

          context.report({
            node: identifier,
            messageId: "restricted",
            data: { name: identifier.name },
          });
        }
      },
    };
  },
};
