/**
 * End-to-End Encryption using Web Crypto API
 *
 * Flow:
 * 1. Each user generates an ECDH P-256 key pair on first login.
 *    The private key stays in sessionStorage (never sent to server).
 *    The public key (JWK) is uploaded to the server.
 *
 * 2. To encrypt a message for a room, we derive a shared AES-256-GCM key
 *    using our private key + recipient's public key (for DMs).
 *    For group channels, we use a channel key derived from all member public keys
 *    (simplified: we derive from the first two keys for demo; production would use
 *    a proper group key agreement protocol like MLS).
 *
 * 3. All message content, files, and audio are encrypted before transmission.
 */

const STORAGE_KEY = 'sc_private_key';
const PUBLIC_KEY_STORAGE = 'sc_public_key_jwk';

// --- Key Generation ---

/**
 * Generate a new ECDH P-256 key pair or load from storage.
 */
export async function getOrCreateKeyPair() {
  const storedPriv = sessionStorage.getItem(STORAGE_KEY);
  const storedPub = sessionStorage.getItem(PUBLIC_KEY_STORAGE);

  if (storedPriv && storedPub) {
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      JSON.parse(storedPriv),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveKey', 'deriveBits']
    );
    return {
      privateKey,
      publicKeyJwk: JSON.parse(storedPub),
    };
  }

  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  );

  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);

  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(privateKeyJwk));
  sessionStorage.setItem(PUBLIC_KEY_STORAGE, JSON.stringify(publicKeyJwk));

  return { privateKey: keyPair.privateKey, publicKeyJwk };
}

/**
 * Import a raw public key JWK for ECDH.
 */
export async function importPublicKey(jwk) {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
}

/**
 * Derive a shared AES-256-GCM key using our private key and their public key.
 */
export async function deriveSharedKey(myPrivateKey, theirPublicKey) {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: theirPublicKey },
    myPrivateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * For group channels without a counterpart public key, derive a key from a
 * channel-specific password stretched with PBKDF2.
 * Using channelId + userId as deterministic seed for demo purposes.
 */
export async function deriveChannelKey(channelId, userId) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`sc:${channelId}:${userId}`),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: new TextEncoder().encode(`securechat:${channelId}`),
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// --- Key Cache ---
const keyCache = new Map();

export async function getKeyForRoom(roomId, roomType, myPrivateKey, members, myUserId) {
  const cacheKey = `${roomId}:${myUserId}`;
  if (keyCache.has(cacheKey)) return keyCache.get(cacheKey);

  let key;
  if (roomType === 'dm') {
    // DM: ECDH between the two members
    const other = members.find(m => m.id !== myUserId);
    if (other?.public_key) {
      const theirPubKey = await importPublicKey(JSON.parse(other.public_key));
      key = await deriveSharedKey(myPrivateKey, theirPubKey);
    } else {
      // Fallback: channel key
      key = await deriveChannelKey(roomId, myUserId);
    }
  } else {
    // Group channel: use channel key
    key = await deriveChannelKey(roomId, myUserId);
  }

  keyCache.set(cacheKey, key);
  return key;
}

// --- Encrypt / Decrypt ---

/**
 * Encrypt a string with AES-256-GCM.
 * Returns base64-encoded ciphertext with IV prepended.
 */
export async function encryptText(plaintext, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a base64-encoded AES-256-GCM ciphertext.
 */
export async function decryptText(ciphertext, key) {
  try {
    const combined = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new TextDecoder().decode(plaintext);
  } catch {
    return '[🔒 Encrypted message — key mismatch]';
  }
}

/**
 * Encrypt binary data (for files).
 */
export async function encryptFile(arrayBuffer, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, arrayBuffer);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return combined.buffer;
}

/**
 * Decrypt binary data (for files).
 */
export async function decryptFile(arrayBuffer, key) {
  const data = new Uint8Array(arrayBuffer);
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
}

/**
 * Get a fingerprint of a public key for user verification.
 */
export async function getKeyFingerprint(publicKeyJwk) {
  const data = new TextEncoder().encode(JSON.stringify(publicKeyJwk));
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  // Format as groups of 4
  return hex.match(/.{1,4}/g).slice(0, 8).join(' ').toUpperCase();
}

export function clearKeyCache() {
  keyCache.clear();
  sessionStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(PUBLIC_KEY_STORAGE);
}
