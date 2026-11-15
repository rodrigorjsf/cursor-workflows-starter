// The stylesheets the browser pages import for their side effect (esbuild bundles them): with `noUncheckedSideEffectImports`
// tsc resolves such an import like any other, so it needs a module to resolve to. Both browser tsconfigs include this file.
declare module "*.css";
