// The lint gate. `next lint` no longer exists in Next 16, so `npm run lint` was
// a broken script until this file and the two devDependencies behind it.
//
// Rule decisions below are deliberate and each carries its reason. Nothing is
// blanket-disabled; "warn" keeps a rule visible in the report without failing
// the gate, for patterns whose fix is a per-site behavioural change.
import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"

export default defineConfig([
  globalIgnores([".next/**", "node_modules/**", "public/**", "next-env.d.ts"]),
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // React 19 / React Compiler-era rules. The codebase predates them and
      // its `useEffect(() => { setLoading(true); fetch(...) })` pattern fires
      // set-state-in-effect 71 times. Each conversion changes when a render
      // happens, so it is per-site work reviewed on its own, not a sweep.
      // Kept at warn so the count is visible and can only go down.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/immutability": "warn",
      // An apostrophe in JSX text is valid and renders correctly. The rule's
      // remaining value — catching a stray `>` or `}` — did not outweigh 15
      // false positives on plain English.
      "react/no-unescaped-entities": "off",
      // Underscore-prefixed names are the codebase's existing convention for
      // "intentionally unused" (route handlers that take `_request`).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
])
