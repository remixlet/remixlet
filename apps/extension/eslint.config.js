import tsParser from "@typescript-eslint/parser";
import { noRuntimeExtensionApi } from "./eslint-rules/no-runtime-extension-api.js";

const platformBoundary = {
  rules: {
    "no-runtime-extension-api": noRuntimeExtensionApi,
  },
};

export default [
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "remixlet-boundaries": platformBoundary,
    },
    rules: {
      "remixlet-boundaries/no-runtime-extension-api": "error",
    },
  },
  {
    files: ["src/platform/**/*.{ts,tsx}"],
    rules: {
      "remixlet-boundaries/no-runtime-extension-api": "off",
    },
  },
];
