// Detected once at load. Used to strip textures / heavy meshes on mobile GPUs
// which crash under the full desktop asset load (1038 meshes + 65MB textures).
// `?mobile=1` query string forces mobile mode for testing.
export const IS_MOBILE = typeof navigator !== 'undefined' && (
  /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (typeof window !== 'undefined' && window.location?.search?.includes('mobile=1'))
)
