/** Browser-safe base64 helpers for text transports such as SSE. */

const CHUNK_SIZE = 32 * 1024;

/** Encode bytes without Buffer or oversized function-argument spreads. */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE)));
  }
  return btoa(chunks.join(""));
};

/** Decode base64, tolerating SSE's multi-line data folding. */
export const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};
