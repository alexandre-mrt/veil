/**
 * Minimal type declarations for circomlibjs.
 * circomlibjs does not ship TypeScript types.
 */
declare module "circomlibjs" {
  interface FieldElement {
    toString(radix?: number): string;
  }

  interface PoseidonField {
    toString(val: Uint8Array | bigint): string;
    toObject(val: Uint8Array | bigint): bigint;
    e(val: bigint | number | string): Uint8Array;
  }

  interface PoseidonFunction {
    (inputs: (bigint | number | string | Uint8Array)[]): Uint8Array;
    F: PoseidonField;
  }

  export function buildPoseidon(): Promise<PoseidonFunction>;
}
