/**
 * deploy.ts — Sui Move contract deployment helper for Veil.
 *
 * Publishes the Move package at contracts/ and extracts created object IDs.
 * Uses the `sui client publish` CLI (requires `sui` in PATH).
 */

import { execSync } from "child_process";
import { join } from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_GAS_BUDGET = 200_000_000;
const CONTRACTS_DIR_NAME = "contracts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ObjectChange {
  readonly type: string;
  readonly packageId?: string;
  readonly objectType?: string;
  readonly objectId?: string;
  readonly owner?: { Shared?: { initial_shared_version: number }; AddressOwner?: string };
}

interface PublishResult {
  readonly objectChanges?: readonly ObjectChange[];
  readonly effects?: { readonly status?: { readonly status: string } };
}

export interface DeployResult {
  readonly packageId: string;
  readonly poolId: string | null;
  readonly treasuryCapId: string | null;
  readonly adminCapId: string | null;
  readonly digest: string;
}

// ---------------------------------------------------------------------------
// Deploy function
// ---------------------------------------------------------------------------

/**
 * Deploys the Veil Move package to the active Sui network.
 *
 * @param projectRoot Absolute path to the project root (parent of contracts/)
 * @param gasBudget Gas budget in MIST (default 200M)
 * @returns Deployment result with package and object IDs
 */
export function deployContract(
  projectRoot: string,
  gasBudget: number = DEFAULT_GAS_BUDGET,
): DeployResult {
  const contractsDir = join(projectRoot, CONTRACTS_DIR_NAME);

  console.log(`[deploy] Publishing from ${contractsDir} with gas budget ${gasBudget}...`);

  let output: string;
  try {
    output = execSync(
      `sui client publish --gas-budget ${gasBudget} --json --skip-dependency-verification`,
      {
        cwd: contractsDir,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      },
    );
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; status?: number; message?: string };
    const combined = (execErr.stdout ?? "") + (execErr.stderr ?? "");
    if (combined.includes('"objectChanges"')) {
      output = combined;
    } else if (combined.includes('"effects"')) {
      output = combined;
    } else {
      throw new Error(`[deploy] Publish failed (exit ${execErr.status}): ${combined.slice(0, 500)}`);
    }
  }

  // The CLI may print warnings before the JSON — find the JSON start
  const jsonStart = output.indexOf("{");
  if (jsonStart === -1) {
    throw new Error(`[deploy] No JSON found in publish output: ${output.slice(0, 500)}`);
  }
  const jsonStr = output.slice(jsonStart);
  const result: PublishResult = JSON.parse(jsonStr);

  // Check transaction status
  const status = result.effects?.status?.status;
  if (status !== "success") {
    throw new Error(`[deploy] Transaction failed with status: ${status}`);
  }

  const changes = result.objectChanges ?? [];

  // Extract package ID from the "published" change
  const published = changes.find((c) => c.type === "published");
  if (!published?.packageId) {
    throw new Error("[deploy] No published package found in objectChanges");
  }
  const packageId = published.packageId;

  // Extract Pool (shared object)
  const poolChange = changes.find(
    (c) =>
      c.type === "created" &&
      c.objectType?.includes("::pool::Pool") &&
      c.owner?.Shared !== undefined,
  );
  const poolId = poolChange?.objectId ?? null;

  // Extract TreasuryCap
  const treasuryCapChange = changes.find(
    (c) => c.type === "created" && c.objectType?.includes("::coin::TreasuryCap"),
  );
  const treasuryCapId = treasuryCapChange?.objectId ?? null;

  // Extract AdminCap
  const adminCapChange = changes.find(
    (c) => c.type === "created" && c.objectType?.includes("::pool::AdminCap"),
  );
  const adminCapId = adminCapChange?.objectId ?? null;

  // Extract digest from the publish output
  // The digest isn't directly in objectChanges; we'll use the published change's digest field
  const digest = (published as ObjectChange & { digest?: string }).digest ?? "unknown";

  console.log(`[deploy] Package published: ${packageId}`);
  console.log(`[deploy] Pool: ${poolId ?? "not created (call create_pool separately)"}`);
  console.log(`[deploy] TreasuryCap: ${treasuryCapId ?? "N/A"}`);
  console.log(`[deploy] AdminCap: ${adminCapId ?? "N/A"}`);

  return { packageId, poolId, treasuryCapId, adminCapId, digest };
}
