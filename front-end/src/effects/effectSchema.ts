/**
 * Single source of truth for what the editor can build.
 *
 * The param specs mirror the defaults in engine/led_patterns.py -- each
 * pattern reads `ctx.params.get(key, default)`, so a key we omit here still
 * renders, it just falls back to the engine default. Keep the two in sync.
 */

export type RGB = [number, number, number]

export type EditorEvent = {
  uid: string // client-only, stable across edits; never written to disk
  id: number // device id: 1 = strip, 2..5 = bulbs
  pattern: string
  start_ms: number
  end_ms: number
  segments: string // strip only; ignored (and dropped on save) for bulbs
  color: RGB
  params: Record<string, unknown>
}

export type TimelineDevice = {
  id: number
  name: string
  kind: 'strip' | 'bulb'
  managed: boolean
}

export type StripZone = {
  name: string
  start: number
  end: number
}

export type EffectsMeta = {
  devices: TimelineDevice[]
  zones: StripZone[]
  pixels: number
  patterns: string[]
}

type ParamDefault = unknown | ((color: RGB) => unknown)

export type ParamSpec = {
  key: string
  label: string
  help?: string
  optional?: boolean // rendered behind an on/off switch
} & (
  | { type: 'number' | 'int'; default: ParamDefault; min: number; max: number; step: number; unit?: string }
  | { type: 'bool'; default: ParamDefault }
  | { type: 'enum'; default: ParamDefault; options: { value: string; label: string }[] }
  | { type: 'color'; default: ParamDefault }
  | { type: 'colorList'; default: ParamDefault }
)

export type PatternSpec = {
  name: string
  label: string
  description: string
  /** Reads well on a single-colour bulb, per BULB_PATTERNS in generate_timeline.py. */
  bulbFriendly: boolean
  params: ParamSpec[]
}

const invert = (color: RGB): RGB => [255 - color[0], 255 - color[1], 255 - color[2]]

export const PATTERN_SPECS: PatternSpec[] = [
  {
    name: 'hold',
    label: 'Hold',
    description: 'Solid, unchanging colour for the whole event.',
    bulbFriendly: true,
    params: [],
  },
  {
    name: 'fade',
    label: 'Fade',
    description: 'Fade in, out, or in-then-out across the duration.',
    bulbFriendly: true,
    params: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'in_out',
        options: [
          { value: 'in_out', label: 'In Then Out' },
          { value: 'in', label: 'In' },
          { value: 'out', label: 'Out' },
        ],
      },
    ],
  },
  {
    name: 'pulse',
    label: 'Pulse',
    description: 'Smooth breathing brightness, repeated N times.',
    bulbFriendly: true,
    params: [
      {
        key: 'cycles',
        label: 'Cycles',
        type: 'int',
        default: 3,
        min: 1,
        max: 64,
        step: 1,
        help: 'Breaths over the whole event',
      },
    ],
  },
  {
    name: 'beats',
    label: 'Beats',
    description: 'Sharp attack then decay — one-shot hit, best on a single beat.',
    bulbFriendly: true,
    params: [
      {
        key: 'attack_ms',
        label: 'Attack',
        type: 'number',
        default: 40,
        min: 1,
        max: 500,
        step: 1,
        unit: 'ms',
        help: 'Time to reach full brightness before the decay starts',
      },
    ],
  },
  {
    name: 'sparkle',
    label: 'Sparkle',
    description: 'Random segments snap on and off every frame.',
    bulbFriendly: false,
    params: [
      {
        key: 'density',
        label: 'Density',
        type: 'number',
        default: 0.25,
        min: 0,
        max: 1,
        step: 0.01,
        help: 'Share of segments lit on any given frame',
      },
    ],
  },
  {
    name: 'twinkle_fade',
    label: 'Twinkle Fade',
    description: 'Starfield — sparks spawn randomly and fade out smoothly.',
    bulbFriendly: false,
    params: [
      { key: 'spawn_chance', label: 'Spawn Chance', type: 'number', default: 0.05, min: 0, max: 1, step: 0.005 },
      { key: 'fade_ms', label: 'Fade Time', type: 'number', default: 600, min: 50, max: 5000, step: 50, unit: 'ms' },
    ],
  },
  {
    name: 'rainbow',
    label: 'Rainbow',
    description: 'Hue gradient across the segments, cycling over the duration.',
    bulbFriendly: false,
    params: [
      {
        key: 'speed',
        label: 'Speed',
        type: 'number',
        default: 1,
        min: 0,
        max: 5,
        step: 0.05,
        help: 'Full hue cycles over the event',
      },
    ],
  },
  {
    name: 'rainbow_jump',
    label: 'Rainbow Jump',
    description: 'Flashes the whole selection through discrete colours.',
    bulbFriendly: true,
    params: [
      { key: 'steps', label: 'Steps', type: 'int', default: 8, min: 2, max: 64, step: 1 },
      {
        key: 'colors',
        label: 'Custom Palette',
        type: 'colorList',
        default: (color: RGB) => [color, invert(color)],
        optional: true,
        help: 'Off = auto-spaced hues',
      },
    ],
  },
  {
    name: 'comet',
    label: 'Comet',
    description: 'A trail that loops continuously around the selection.',
    bulbFriendly: false,
    params: [
      { key: 'length', label: 'Trail Length', type: 'int', default: 5, min: 1, max: 45, step: 1 },
      { key: 'passes', label: 'Passes', type: 'int', default: 2, min: 1, max: 20, step: 1 },
    ],
  },
  {
    name: 'snake',
    label: 'Snake',
    description: 'A short trail travels the selection once, entering and exiting cleanly.',
    bulbFriendly: false,
    params: [
      { key: 'length', label: 'Length', type: 'int', default: 4, min: 1, max: 45, step: 1 },
      { key: 'passes', label: 'Passes', type: 'int', default: 1, min: 1, max: 20, step: 1 },
    ],
  },
  {
    name: 'bounce',
    label: 'Bounce',
    description: 'A dot with a trail bounces between the two ends.',
    bulbFriendly: false,
    params: [
      { key: 'passes', label: 'Passes', type: 'int', default: 3, min: 1, max: 20, step: 1 },
      { key: 'trail', label: 'Trail', type: 'int', default: 3, min: 1, max: 20, step: 1 },
    ],
  },
  {
    name: 'criss_cross',
    label: 'Criss Cross',
    description: 'Two dots start at opposite ends and cross paths.',
    bulbFriendly: false,
    params: [
      { key: 'passes', label: 'Passes', type: 'int', default: 1, min: 1, max: 20, step: 1 },
      { key: 'color_b', label: 'Second Colour', type: 'color', default: (color: RGB) => invert(color) },
    ],
  },
  {
    name: 'alt_band',
    label: 'Alt Band',
    description: 'Alternating stripes of colour and black, marching along the strip.',
    bulbFriendly: false,
    params: [
      { key: 'band_size', label: 'Band Size', type: 'int', default: 3, min: 1, max: 20, step: 1 },
      {
        key: 'speed',
        label: 'Speed',
        type: 'number',
        default: 5,
        min: 0,
        max: 60,
        step: 1,
        unit: 'seg/s',
        help: 'Segments shifted per second',
      },
    ],
  },
  {
    name: 'stack',
    label: 'Stack',
    description: 'Segments fill up one by one, progress-bar style.',
    bulbFriendly: false,
    params: [
      {
        key: 'reverse',
        label: 'Reverse',
        type: 'bool',
        default: false,
        help: 'Fill from the far end of the selection back toward its start',
      },
    ],
  },
  {
    name: 'scramble',
    label: 'Scramble',
    description: 'Reshuffles colours across the segments on an interval.',
    bulbFriendly: true,
    params: [
      { key: 'interval_ms', label: 'Interval', type: 'number', default: 150, min: 20, max: 2000, step: 10, unit: 'ms' },
      { key: 'colors', label: 'Palette', type: 'colorList', default: (color: RGB) => [color, invert(color)] },
    ],
  },
  {
    name: 'audio_spectrum',
    label: 'Audio Spectrum',
    description: 'Live FFT of the song mapped across the selection.',
    bulbFriendly: false,
    params: [
      { key: 'sensitivity', label: 'Sensitivity', type: 'number', default: 30, min: 5, max: 100, step: 1 },
      { key: 'rainbow', label: 'Rainbow Mode', type: 'bool', default: true, help: 'Off = use the event colour' },
    ],
  },
]

export const PATTERN_BY_NAME: Record<string, PatternSpec> = Object.fromEntries(
  PATTERN_SPECS.map((spec) => [spec.name, spec]),
)

export const patternLabel = (name: string) => PATTERN_BY_NAME[name]?.label ?? name

export const resolveParamDefault = (spec: ParamSpec, color: RGB): unknown =>
  typeof spec.default === 'function' ? (spec.default as (c: RGB) => unknown)(color) : spec.default

/** Params for a fresh event of this pattern, skipping optional ones. */
export const defaultParams = (pattern: string, color: RGB): Record<string, unknown> => {
  const spec = PATTERN_BY_NAME[pattern]
  if (!spec) return {}
  const out: Record<string, unknown> = {}
  for (const param of spec.params) {
    if (param.optional) continue
    out[param.key] = resolveParamDefault(param, color)
  }
  return out
}

// --- Colours ---------------------------------------------------------------

const clampChannel = (value: number) => Math.max(0, Math.min(255, Math.round(value)))

export const toRgb = (value: unknown): RGB => {
  if (Array.isArray(value) && value.length === 3) {
    return [clampChannel(Number(value[0])), clampChannel(Number(value[1])), clampChannel(Number(value[2]))]
  }
  return [255, 255, 255]
}

export const rgbToHex = (rgb: RGB) =>
  `#${rgb.map((c) => clampChannel(c).toString(16).padStart(2, '0')).join('')}`

export const hexToRgb = (hex: string): RGB => {
  const clean = hex.replace('#', '').trim()
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return [255, 255, 255]
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

export const rgbCss = (rgb: RGB) => `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`

/** Perceived luminance, for picking readable text over an event block. */
export const isLight = (rgb: RGB) => (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 > 140

// --- Segments --------------------------------------------------------------

export type SegmentParse =
  | { ok: true; indices: number[]; all: boolean }
  | { ok: false; error: string }

/**
 * Mirrors resolve_segments() in engine/led_patterns.py: "all", a zone name,
 * a single index, an "a-b" range, or any comma-separated combination.
 * Out-of-range indices are an error here because they crash the player.
 */
export const parseSegments = (value: string, zones: StripZone[], pixels: number): SegmentParse => {
  const text = (value ?? '').trim()
  if (!text) return { ok: false, error: 'Enter at least one segment' }

  const zoneByName = new Map(zones.map((z) => [z.name.toLowerCase(), z]))
  const indices: number[] = []
  let sawAll = false

  for (const rawToken of text.split(',')) {
    const token = rawToken.trim()
    if (!token) return { ok: false, error: 'Empty value between commas' }
    const lower = token.toLowerCase()

    if (lower === 'all') {
      sawAll = true
      for (let i = 0; i < pixels; i += 1) indices.push(i)
      continue
    }

    const zone = zoneByName.get(lower)
    if (zone) {
      for (let i = zone.start; i <= zone.end; i += 1) indices.push(i)
      continue
    }

    const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/)
    if (rangeMatch) {
      const lo = Number(rangeMatch[1])
      const hi = Number(rangeMatch[2])
      if (lo > hi) return { ok: false, error: `Range "${token}" is backwards` }
      if (hi >= pixels) return { ok: false, error: `Pixel ${hi} is outside 0-${pixels - 1}` }
      for (let i = lo; i <= hi; i += 1) indices.push(i)
      continue
    }

    if (/^\d+$/.test(token)) {
      const idx = Number(token)
      if (idx >= pixels) return { ok: false, error: `Pixel ${idx} is outside 0-${pixels - 1}` }
      indices.push(idx)
      continue
    }

    return { ok: false, error: `"${token}" is not a zone, index or range` }
  }

  return { ok: true, indices: Array.from(new Set(indices)).sort((a, b) => a - b), all: sawAll }
}

/** Compresses [0,1,2,7] into "0-2,7" for display. */
export const indicesToText = (indices: number[]): string => {
  const sorted = Array.from(new Set(indices)).sort((a, b) => a - b)
  const parts: string[] = []
  let runStart: number | null = null
  let prev: number | null = null

  for (const idx of sorted) {
    if (runStart === null) {
      runStart = idx
    } else if (prev !== null && idx !== prev + 1) {
      parts.push(runStart === prev ? `${runStart}` : `${runStart}-${prev}`)
      runStart = idx
    }
    prev = idx
  }
  if (runStart !== null && prev !== null) {
    parts.push(runStart === prev ? `${runStart}` : `${runStart}-${prev}`)
  }
  return parts.join(',')
}

/** Timelines may store segments as a list of indices; normalize to text. */
export const segmentsToText = (value: unknown): string => {
  if (Array.isArray(value)) return indicesToText(value.map((v) => Number(v)).filter(Number.isFinite))
  if (typeof value === 'string' && value.trim()) return value.trim()
  return 'all'
}

export type SegmentMode = 'all' | 'zones' | 'custom'

/** Which of the three inspector modes a segments string belongs to. */
export const segmentMode = (value: string, zones: StripZone[]): SegmentMode => {
  const tokens = value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
  if (tokens.length === 1 && tokens[0] === 'all') return 'all'
  const zoneNames = new Set(zones.map((z) => z.name.toLowerCase()))
  if (tokens.length > 0 && tokens.every((t) => zoneNames.has(t))) return 'zones'
  return 'custom'
}

// --- Time ------------------------------------------------------------------

export const formatClock = (ms: number, withMs = false) => {
  const safe = Math.max(0, ms)
  const totalSeconds = Math.floor(safe / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const base = `${minutes}:${String(seconds).padStart(2, '0')}`
  return withMs ? `${base}.${String(Math.floor(safe % 1000)).padStart(3, '0')}` : base
}

let uidCounter = 0
export const nextUid = () => `ev-${Date.now().toString(36)}-${(uidCounter += 1).toString(36)}`
