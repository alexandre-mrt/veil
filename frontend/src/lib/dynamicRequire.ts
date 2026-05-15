/**
 * Dynamically imports a module by name, bypassing webpack static analysis.
 * This prevents build failures when optional dependencies are not installed.
 *
 * Uses Function constructor to create a dynamic import that webpack cannot
 * statically analyze, allowing optional dependencies to be missing at build time.
 */
export async function dynamicRequire(moduleName: string): Promise<unknown> {
  const importFn = new Function("m", "return import(m)") as (
    m: string,
  ) => Promise<unknown>;
  return importFn(moduleName);
}
