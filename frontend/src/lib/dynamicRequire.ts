/**
 * Dynamically imports known optional dependencies.
 */
export async function dynamicRequire(moduleName: string): Promise<unknown> {
  switch (moduleName) {
    case "circomlibjs":
      // @ts-expect-error — no type declarations
      return import("circomlibjs");
    case "snarkjs":
      // @ts-expect-error — no type declarations for dynamic import
      return import("snarkjs");
    default:
      throw new Error(`Unknown dynamic module: ${moduleName}`);
  }
}
