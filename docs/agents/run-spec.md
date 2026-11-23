# run-spec in this repository

typecheck: mise exec -- npm run typecheck
test: mise exec -- npx tsx --tsconfig packages/runtime/tsconfig.test.json --test --test-timeout=600000 packages/runtime/test/*.test.ts packages/dashboard/test/*.test.ts skills/cursor-workflow-authoring/examples/*/*.test.ts test/*.test.ts

This repository has no lint: mechanical rules are `node:test` convention checks inside the suite. The test line runs the whole
suite, the same tests `npm test` runs, in one runner: narrow it by replacing the file list with the Scoped tests. The
tsconfig maps `@cursor/sdk` to the fake SDK, so no test reaches the Cursor API. The full suite takes minutes; give it a
timeout of 20 minutes or run it in the background.
