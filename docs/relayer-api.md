# Veil Relayer API

The Veil relayer provides sponsored transaction submission for sender privacy. It pays gas fees on behalf of users so that the on-chain transaction shows the relayer address as the gas payer, hiding the user's network-level identity.

Base URL: `http://localhost:3001` (dev) or configured via `RELAYER_URL`

## Architecture

```
User Browser                        Relayer Server                    Sui Network
     |                                    |                                |
     |-- POST /sponsor {kindBytes} ------>|                                |
     |<-- {txBytes, sponsor} -------------|                                |
     |                                    |                                |
     |  [user signs txBytes locally]      |                                |
     |                                    |                                |
     |-- POST /submit {txBytes, sig} ---->|                                |
     |                                    |-- executeTransactionBlock ---->|
     |                                    |<-- {digest, effects} ---------|
     |<-- {digest} ----------------------|                                |
```

On-chain, the transaction appears as:
- **sender**: user address (Move-level authorization)
- **gas payer**: relayer address (who submitted and paid)

## Authentication

All endpoints except `/health` require a Bearer token when `RELAYER_API_KEY` is set:

```
Authorization: Bearer <RELAYER_API_KEY>
```

In development mode (no `RELAYER_API_KEY` set), authentication is skipped with a warning.

## Endpoints

### GET /health

Public health check. No authentication required.

**Response (200)**:
```json
{
  "status": "ok",
  "relayer": "0x<relayer-sui-address>",
  "network": "testnet"
}
```

### POST /sponsor

Sponsor a transaction by wrapping the user's `TransactionKind` with gas payment data. Returns full `TransactionData` bytes for the user to sign.

**Request**:
```json
{
  "kindBytes": "<base64-encoded TransactionKind>",
  "sender": "<user-sui-address>"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `kindBytes` | string (base64) | The user's intended Move calls, built with `onlyTransactionKind: true` |
| `sender` | string | The user's Sui address (logical sender for Move authorization) |

**Response (200)**:
```json
{
  "txBytes": "<base64-encoded full TransactionData>",
  "sponsor": "0x<relayer-address>"
}
```

**Errors**:

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{ "error": "Missing kindBytes or sender" }` | Missing required fields |
| 401 | `{ "error": "Unauthorized" }` | Invalid or missing Bearer token |
| 413 | `{ "error": "Payload too large" }` | Request body exceeds 50KB |
| 429 | `{ "error": "Too many requests" }` | Rate limit exceeded |
| 500 | `{ "error": "Sponsorship failed" }` | Internal error (e.g., relayer has no gas coins) |

### POST /submit

Submit a dual-signed transaction to the Sui network. The user provides their signature over `txBytes`; the relayer co-signs the gas payment portion.

**Request**:
```json
{
  "txBytes": "<base64-encoded TransactionData>",
  "userSignature": "<base64-encoded user signature>"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `txBytes` | string (base64) | The full TransactionData bytes (from `/sponsor` response) |
| `userSignature` | string (base64) | The user's signature over `txBytes` |

**Response (200)**:
```json
{
  "digest": "0x<transaction-digest>",
  "success": true
}
```

**Response (200, transaction failed on-chain)**:
```json
{
  "digest": "0x<transaction-digest>",
  "success": false,
  "error": "Transaction failed: <move-error-details>"
}
```

**Errors**:

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{ "error": "Missing txBytes or userSignature" }` | Missing required fields |
| 401 | `{ "error": "Unauthorized" }` | Invalid or missing Bearer token |
| 413 | `{ "error": "Payload too large" }` | Request body exceeds 50KB |
| 429 | `{ "error": "Too many requests" }` | Rate limit exceeded |
| 500 | `{ "error": "Submission failed" }` | Internal error during submission |

## Rate Limits

- **10 requests per minute per IP** (sliding window)
- **50KB max payload size** per request
- Client IP is resolved from Bun's native `requestIP`, falling back to `X-Forwarded-For` and `X-Real-IP` headers

## CORS

- **Production**: allows only the configured origin (`RELAYER_CORS_ORIGIN` env var, defaults to the Vercel deployment URL)
- **Development** (`NODE_ENV !== "production"`): also allows `http://localhost:3000`
- Allowed methods: `POST`, `GET`, `OPTIONS`
- Allowed headers: `Content-Type`, `Authorization`

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RELAYER_API_KEY` | No (dev) / Yes (prod) | None | Bearer token for authentication |
| `RELAYER_CORS_ORIGIN` | No | Vercel deploy URL | Allowed CORS origin |
| `NODE_ENV` | No | None | Set to `production` to disable localhost CORS |

## Gas Budget

The relayer uses a fixed gas budget of **0.05 SUI** (50,000,000 MIST) per sponsored transaction. The relayer's active Sui CLI address must have sufficient SUI balance.

## Running the Relayer

```bash
# Development server (port 3001)
cd scripts && bun run relayer

# Custom port
cd scripts && bun run src/relayer.ts serve --port 8080

# Demo mode (single-machine end-to-end test)
cd scripts && bun run relayer:demo
```
