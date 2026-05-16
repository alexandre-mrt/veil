/**
 * Shared AES-GCM encryption helpers for localStorage data.
 * Primary: IndexedDB non-extractable keys (XSS-resistant).
 * Fallback: PBKDF2 key derivation from wallet address (incognito / unsupported browsers).
 *
 * Extracted from usePrivateState.ts for reuse in credential storage.
 */

const APP_SALT = new TextEncoder().encode("veil-privacy-protocol-v1");
const PBKDF2_ITERATIONS = 100_000;
const IV_LENGTH = 12;

// ---------------------------------------------------------------------------
// IndexedDB keystore -- non-extractable AES keys (primary)
// ---------------------------------------------------------------------------

const IDB_NAME = "veil-keystore";
const IDB_STORE = "keys";

function openKeystore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(IDB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getStoredKey(
  db: IDBDatabase,
  walletAddress: string,
): Promise<CryptoKey | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const store = tx.objectStore(IDB_STORE);
    const request = store.get(walletAddress);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

function putStoredKey(
  db: IDBDatabase,
  walletAddress: string,
  key: CryptoKey,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    const request = store.put(key, walletAddress);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get or create a non-extractable AES-GCM key stored in IndexedDB.
 * IndexedDB is origin-scoped, and the key is non-extractable, meaning
 * even XSS cannot export the raw key material.
 */
async function getOrCreateIndexedDBKey(
  walletAddress: string,
): Promise<CryptoKey> {
  const db = await openKeystore();
  try {
    const existing = await getStoredKey(db, walletAddress);
    if (existing) return existing;

    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false, // non-extractable
      ["encrypt", "decrypt"],
    );
    await putStoredKey(db, walletAddress, key);
    return key;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// PBKDF2 fallback -- for incognito mode or browsers without IndexedDB
// ---------------------------------------------------------------------------

async function derivePBKDF2Key(walletAddress: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(walletAddress),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: APP_SALT,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ---------------------------------------------------------------------------
// Key derivation -- IndexedDB primary, PBKDF2 fallback
// ---------------------------------------------------------------------------

/**
 * Derive an AES-256-GCM key for a wallet address.
 * Uses IndexedDB non-extractable key (primary) with PBKDF2 fallback
 * for environments where IndexedDB is unavailable (incognito, SSR, etc.).
 */
export async function deriveKey(walletAddress: string): Promise<CryptoKey> {
  try {
    return await getOrCreateIndexedDBKey(walletAddress);
  } catch {
    // Fallback: incognito mode, SSR, or unsupported browser
    return derivePBKDF2Key(walletAddress);
  }
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt -- AES-GCM with iv prepended
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext string with AES-GCM, returning a base64 string (iv + ciphertext).
 */
export async function encryptData(
  plaintext: string,
  key: CryptoKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a base64-encoded AES-GCM ciphertext (iv + ciphertext) back to plaintext.
 */
export async function decryptData(
  encrypted: string,
  key: CryptoKey,
): Promise<string> {
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}
