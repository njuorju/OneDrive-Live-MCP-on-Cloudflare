export const RENDER_CACHE_MAX_BYTES = 32 * 1024 * 1024;

export function renderCacheSizeAccepted(byteLength: number): boolean {
  return Number.isInteger(byteLength) && byteLength >= 5 && byteLength <= RENDER_CACHE_MAX_BYTES;
}
