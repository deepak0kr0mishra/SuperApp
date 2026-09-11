/**
 * DEPRECATED — E2E encryption has been removed from the app.
 * This module is kept as a no-op shim so old imports don't crash.
 * All functions are identity / pass-through.
 */

export async function getOrCreateKeyPair() {
  return { privateKey: null, publicKeyJwk: null };
}

export async function importPublicKey() {
  return null;
}

export async function deriveSharedKey() {
  return null;
}

export async function deriveChannelKey() {
  return null;
}

export async function getKeyForRoom() {
  return null;
}

export async function encryptText(plaintext) {
  return plaintext || '';
}

export async function decryptText(ciphertext) {
  return ciphertext || '';
}

export async function encryptFile(arrayBuffer) {
  return arrayBuffer;
}

export async function decryptFile(arrayBuffer) {
  return arrayBuffer;
}

export async function getKeyFingerprint() {
  return 'NO-ENCRYPTION';
}

export function clearKeyCache() {}
