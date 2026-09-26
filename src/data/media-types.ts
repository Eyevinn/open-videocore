// The media content types this API accepts on an asset upload — ONE list, used
// by both the producer and the consumers of that fact (issue #822).
//
// Producer: `src/main.ts` registers a pass-through body parser for each entry so
// `PUT /api/v1/assets/:id/upload` can stream the bytes straight to storage.
// That registration list WAS the only statement of "which media types can enter
// this system", which meant anything else that needed the same fact had to
// restate it and could silently drift out of step. It now iterates this array.
//
// Consumer: `matchesMimeTypeFilter` / `isUnmatchableMimeTypeFilter` in
// `search-repo.ts`. The search `mimeType` filter rejects a MIME-shaped value
// that can never match any asset; a type in THIS list can be carried by a real
// asset, so it must never be rejected, whether or not the alias map happens to
// resolve it onto a container family yet. Deriving the check from this array is
// what keeps the two from drifting: adding an upload type here automatically
// stops the search filter rejecting it.
export const UPLOAD_CONTENT_TYPES: readonly string[] = [
  'application/octet-stream',
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/webm',
  'video/mpeg',
  'video/ogg',
  'video/3gpp',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/flac',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp'
];

const UPLOAD_CONTENT_TYPE_SET = new Set(UPLOAD_CONTENT_TYPES);

// Normalise a content type for comparison: drop any parameters
// (`video/mp4; codecs="avc1.42E01E"`), trim, lower-case. Per RFC 9110 §8.3 the
// type and subtype are case-insensitive.
export function normaliseContentType(value: string): string {
  return value.split(';')[0]!.trim().toLowerCase();
}

// True when this API accepts the content type on an asset upload, i.e. an asset
// carrying it can legitimately exist in a workspace.
export function isAcceptedUploadContentType(value: string): boolean {
  return UPLOAD_CONTENT_TYPE_SET.has(normaliseContentType(value));
}
