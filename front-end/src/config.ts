// Defaults to the Orange Pi on the LAN; override with VITE_API_BASE_URL when
// running the frontend against a server on another host (e.g. localhost).
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://192.168.2.27:8080'

/** Hash route the effect editor opens in its own tab. */
export const effectEditorUrl = (basename: string) =>
  `${window.location.origin}${window.location.pathname}#/effects/${encodeURIComponent(basename)}`
