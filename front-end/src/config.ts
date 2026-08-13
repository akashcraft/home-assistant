/**
 * A production build is served by Flask itself, so it talks to whatever host
 * the page came from -- open it at localhost, the Pi's LAN IP or a hostname
 * and it just works, with no address compiled in.
 *
 * `npm run dev` runs on vite's own port, so there it points at the LAN server
 * instead. Override either with VITE_API_BASE_URL.
 */
const DEV_API_BASE_URL = 'http://192.168.2.27:8080'

export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ??
  (import.meta.env.PROD ? window.location.origin : DEV_API_BASE_URL)

/**
 * Device id 1 is always the LED strip -- it has per-segment logic no bulb
 * has, so it can be re-addressed but never removed. Mirrors STRIP_DEVICE_ID
 * in server.py and engine/devices.py.
 */
export const STRIP_DEVICE_ID = 1

export const isStrip = (id?: number) => id === STRIP_DEVICE_ID

/** Hash route the effect editor opens in its own tab. */
export const effectEditorUrl = (basename: string) =>
  `${window.location.origin}${window.location.pathname}#/effects/${encodeURIComponent(basename)}`

/**
 * Library preferences, persisted per browser in localStorage.
 *
 * They're read from three places (the library drawer, the effect editor's
 * Generate call, and App), so keys and defaults live here -- the editor used
 * to carry its own copy of the defaults and quietly disagreed with the
 * checkboxes on a browser that had never stored anything.
 *
 * These apply only to a browser with nothing saved yet. localStorage is
 * per-origin, so opening the UI on a new host or port counts as new.
 */
export const LS_LINK_TO_LIGHTS = 'library.linkToLights'
export const LS_INCLUDE_BULBS = 'library.includeBulbs'
export const LS_SEGMENTS_MODE = 'library.segmentsMode'

export const SEGMENTS_MODES = ['all', 'zones', 'mix'] as const
export type SegmentsMode = (typeof SEGMENTS_MODES)[number]

export const DEFAULT_LINK_TO_LIGHTS = true
export const DEFAULT_INCLUDE_BULBS = false
export const DEFAULT_SEGMENTS_MODE: SegmentsMode = 'all'

const readBool = (key: string, fallback: boolean): boolean => {
  const raw = localStorage.getItem(key)
  return raw === null ? fallback : raw === 'true'
}

export const readLinkToLights = () => readBool(LS_LINK_TO_LIGHTS, DEFAULT_LINK_TO_LIGHTS)
export const readIncludeBulbs = () => readBool(LS_INCLUDE_BULBS, DEFAULT_INCLUDE_BULBS)

export const readSegmentsMode = (): SegmentsMode => {
  const raw = localStorage.getItem(LS_SEGMENTS_MODE)
  return (SEGMENTS_MODES as readonly string[]).includes(raw ?? '')
    ? (raw as SegmentsMode)
    : DEFAULT_SEGMENTS_MODE
}
