/**
 * End-to-End Encryption using Web Crypto API
 *
 * Key design:
 * - Each user has an ECDH P-256 key pair (private key stays in sessionStorage)
 * - Group channels: AES-256-GCM key derived from channelId only (same for all members)
 * - DMs: AES-256-GCM key derived via ECDH between the two users' keys
 */

const STORAGE_KEY = 'sc_private_key';
const PUBLIC_KEY_STORAGE = 'sc_public_key_jwk';

// --- Key Generation ---

export async function getOrCreateKeyPair() {
  const storedPriv = sessionStorage.getItem(STORAGE_KEY);
  const storedPub = sessionStorage.getItem(PUBLIC_KEY_STORAGE);

  if (storedPriv && storedPub) {
    try {
      const privateKey = await crypto.subtle.importKey(
        'jwk',
        JSON.parse(storedPriv),
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveKey', 'deriveBits']
      );
      return { privateKey, publicKeyJwk: JSON.parse(storedPub) };
    } catch {
      // Corrupted — regenerate
      sessionStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(PUBLIC_KEY_STORAGE);
    }
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

export async function importPublicKey(jwk) {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
}

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
 * Derive a channel key from channelId ONLY (same result for all members).
 * Uses PBKDF2 with a fixed application salt so everyone in the channel
 * arrives at the same AES-256-GCM key.
 */
export async function deriveChannelKey(channelId) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`securechat:channel:${channelId}`),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: new TextEncoder().encode(`sc:v1:${channelId}`),
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

/**
 * Get the encryption key for a room.
 * - DM: ECDH between myPrivateKey + other user's publicKey
 * - Channel: deterministic key from channelId (same for all members)
 */
export async function getKeyForRoom(roomId, roomType, myPrivateKey, members, myUserId) {
  // For channels, key is the same for everyone — cache by roomId only
  const cacheKey = roomType === 'dm' ? `${roomId}:${myUserId}` : roomId;
  if (keyCache.has(cacheKey)) return keyCache.get(cacheKey);

  let key;
  if (roomType === 'dm') {
    const other = members.find(m => m.id !== myUserId);
    if (other?.public_key) {
      try {
        const theirPubKey = await importPublicKey(
          typeof other.public_key === 'string' ? JSON.parse(other.public_key) : other.public_key
        );
        key = await deriveSharedKey(myPrivateKey, theirPubKey);
      } catch {
        // Fallback if public key parse fails
        key = await deriveChannelKey(roomId);
      }
    } else {
      // Other user hasn't uploaded their public key yet
      key = await deriveChannelKey(roomId);
    }
  } else {
    // Group channel — everyone derives the same key from the room ID
    key = await deriveChannelKey(roomId);
  }

  keyCache.set(cacheKey, key);
  return key;
}

// --- Encrypt / Decrypt Text ---

export async function encryptText(plaintext, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptText(ciphertext, key) {
  try {
    const combined = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new TextDecoder().decode(plaintext);
  } catch {
    return '[🔒 Encrypted message]';
  }
}

// --- Encrypt / Decrypt Files ---

export async function encryptFile(arrayBuffer, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, arrayBuffer);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return combined.buffer;
}

export async function decryptFile(arrayBuffer, key) {
  const data = new Uint8Array(arrayBuffer);
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
}

// --- Key Fingerprint ---

export async function getKeyFingerprint(publicKeyJwk) {
  const data = new TextEncoder().encode(JSON.stringify(publicKeyJwk));
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.match(/.{1,4}/g).slice(0, 8).join(' ').toUpperCase();
}

export function clearKeyCache() {
  keyCache.clear();
  sessionStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(PUBLIC_KEY_STORAGE);
}
