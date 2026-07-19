import { getGatewayUrl } from "./gateway";

/**
 * Same-origin URL for reading or writing a home file's content through the
 * gateway's `/api/files/blob` route. File reads must use this instead of raw
 * `/files/*` URLs: the blob route shares the authenticated `/api` path that
 * works behind the platform session router, while direct `/files/*` requests
 * can 401/404 for signed-in users depending on routing state.
 */
export function fileBlobUrl(path: string): string {
  return `${getGatewayUrl()}/api/files/blob?path=${encodeURIComponent(path)}`;
}

/**
 * Authenticated streaming URL for owner media. Unlike the bounded blob route,
 * this endpoint supports large files and browser byte-range requests.
 */
export function fileMediaUrl(path: string): string {
  return `${getGatewayUrl()}/api/files/media?path=${encodeURIComponent(path)}`;
}
