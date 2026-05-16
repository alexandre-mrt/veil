/**
 * relayer.ts — Veil relayer client utilities.
 *
 * Provides functions to interact with the Veil relayer server for sender privacy.
 * The relayer sponsors and submits transactions so the user's address is not
 * directly visible as the transaction submitter on-chain.
 *
 * Architecture:
 *   User (browser) → Relayer (server) → Sui Network
 *   On-chain: sender = user (Move auth), gas payer = relayer (network identity)
 *
 * See: scripts/src/relayer.ts for the server implementation.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RelayerConfig {
  /** Relayer server base URL */
  readonly url: string;
  /** Request timeout in ms */
  readonly timeoutMs?: number;
}

export interface SponsorRequest {
  /** Base64-encoded TransactionKind bytes */
  readonly kindBytes: string;
  /** User's Sui address */
  readonly sender: string;
}

export interface SponsorResponse {
  /** Base64-encoded full TransactionData bytes (with relayer's gas) */
  readonly txBytes: string;
  /** Relayer's address (gas payer) */
  readonly sponsor: string;
}

export interface SubmitRequest {
  /** Base64-encoded TransactionData bytes */
  readonly txBytes: string;
  /** User's base64 signature */
  readonly userSignature: string;
}

export interface SubmitResponse {
  readonly digest: string;
  readonly success: boolean;
  readonly error?: string;
}

export interface RelayerHealth {
  readonly status: string;
  readonly relayer: string;
  readonly network: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;

const DEFAULT_CONFIG: RelayerConfig = {
  url: process.env.NEXT_PUBLIC_RELAYER_URL ?? "http://localhost:3001",
  timeoutMs: DEFAULT_TIMEOUT_MS,
};

// ---------------------------------------------------------------------------
// Client Functions
// ---------------------------------------------------------------------------

/**
 * Check if the relayer server is available.
 */
export async function checkRelayerHealth(
  config: RelayerConfig = DEFAULT_CONFIG,
): Promise<RelayerHealth | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    const res = await fetch(`${config.url}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    return (await res.json()) as RelayerHealth;
  } catch {
    return null;
  }
}

/**
 * Request the relayer to sponsor a transaction.
 * Returns full TransactionData bytes that the user should sign.
 */
export async function requestSponsorship(
  request: SponsorRequest,
  config: RelayerConfig = DEFAULT_CONFIG,
): Promise<SponsorResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  const res = await fetch(`${config.url}/sponsor`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: controller.signal,
  });
  clearTimeout(timeout);

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Relayer unavailable" }));
    throw new Error(body.error ?? `Sponsor request failed (${res.status})`);
  }

  return (await res.json()) as SponsorResponse;
}

/**
 * Submit a user-signed transaction via the relayer.
 * The relayer co-signs (gas payment) and submits to the Sui network.
 */
export async function submitViaRelayer(
  request: SubmitRequest,
  config: RelayerConfig = DEFAULT_CONFIG,
): Promise<SubmitResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  const res = await fetch(`${config.url}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: controller.signal,
  });
  clearTimeout(timeout);

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Submit failed" }));
    throw new Error(body.error ?? `Submit request failed (${res.status})`);
  }

  return (await res.json()) as SubmitResponse;
}

/**
 * Convenience: full sponsored transaction flow in one call.
 *
 * @param kindBytes Base64-encoded TransactionKind bytes
 * @param sender User's Sui address
 * @param signFn Callback to sign the full tx bytes (returns base64 signature)
 * @param config Relayer configuration
 */
export async function sponsoredTransfer(
  kindBytes: string,
  sender: string,
  signFn: (txBytes: string) => Promise<string>,
  config: RelayerConfig = DEFAULT_CONFIG,
): Promise<SubmitResponse> {
  // Step 1: Request sponsorship
  const { txBytes } = await requestSponsorship({ kindBytes, sender }, config);

  // Step 2: User signs the full TransactionData
  const userSignature = await signFn(txBytes);

  // Step 3: Submit via relayer
  return submitViaRelayer({ txBytes, userSignature }, config);
}
