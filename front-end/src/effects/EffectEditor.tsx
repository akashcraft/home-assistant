import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  CssBaseline,
  IconButton,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
  alpha,
} from '@mui/material'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { RedoRounded, UndoRounded } from '@mui/icons-material'
import { API_BASE_URL } from '../config'
import EffectPalette from './EffectPalette'
import EffectInspector from './EffectInspector'
import EffectTimeline, { SNAP_STEP_MS, type EventUpdate } from './EffectTimeline'
import {
  defaultParams,
  nextUid,
  patternLabel,
  segmentsToText,
  toRgb,
  type EditorEvent,
  type EffectsMeta,
  type RGB,
  type TimelineDevice,
} from './effectSchema'

const editorTheme = createTheme({
  palette: {
    mode: 'dark',
    background: { default: '#06070b', paper: '#0d1018' },
    primary: { main: '#8ab4ff' },
    text: { primary: '#f7f8fb', secondary: '#a8b0bf' },
  },
  typography: {
    fontFamily:
      '"SF Pro Display", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  shape: { borderRadius: 14 },
})

const LS_SYNC_LIGHTS = 'effects.syncLights'
/** Shift + arrow key jump; plain arrows nudge by SNAP_STEP_MS. */
const COARSE_NUDGE_MS = 1000
const NEW_EVENT_COLOR: RGB = [138, 180, 255]
const NEW_EVENT_MS = 2000
const TAIL_PADDING_MS = 4000
const MIN_PX_PER_MS = 0.00002
const MAX_PX_PER_MS = 1

type WireEvent = {
  id: number
  pattern: string
  start_ms: number
  end_ms: number
  segments?: string
  color: RGB
  params: Record<string, unknown>
}

type EditorState = {
  events: EditorEvent[]
  past: EditorEvent[][]
  future: EditorEvent[][]
}

const panelSx = {
  minHeight: 0,
  borderRadius: '1rem',
  overflow: 'hidden',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.015))',
  border: '1px solid rgba(255,255,255,0.07)',
} as const

/** Disk shape -> editor shape. Bulb events have no segments key. */
const fromWire = (raw: unknown, index: number): EditorEvent => {
  const source = (raw ?? {}) as Record<string, unknown>
  const start = Number(source.start_ms ?? 0)
  const end = Number(source.end_ms ?? start + NEW_EVENT_MS)
  return {
    uid: `load-${index}-${nextUid()}`,
    id: Number(source.id ?? 1) || 1,
    pattern: String(source.pattern ?? 'hold'),
    start_ms: Math.max(0, Math.round(start)),
    end_ms: Math.max(Math.round(start) + 50, Math.round(end)),
    segments: segmentsToText(source.segments),
    color: toRgb(source.color),
    params: (source.params && typeof source.params === 'object' ? source.params : {}) as Record<string, unknown>,
  }
}

/** Editor shape -> disk shape, in the key order generate_timeline.py writes. */
const toWire = (events: EditorEvent[]): WireEvent[] =>
  events
    .map((event) => {
      const wire: WireEvent = {
        id: event.id,
        pattern: event.pattern,
        start_ms: Math.round(event.start_ms),
        end_ms: Math.round(event.end_ms),
        color: event.color,
        params: event.params,
      }
      if (event.id === 1) {
        return {
          id: wire.id,
          pattern: wire.pattern,
          start_ms: wire.start_ms,
          end_ms: wire.end_ms,
          segments: event.segments,
          color: wire.color,
          params: wire.params,
        }
      }
      return wire
    })
    .sort((a, b) => a.start_ms - b.start_ms || a.id - b.id)

type EffectEditorProps = { basename: string }

function EffectEditor({ basename }: EffectEditorProps) {
  const [meta, setMeta] = useState<EffectsMeta | null>(null)
  const [state, setState] = useState<EditorState>({ events: [], past: [], future: [] })
  const [baseline, setBaseline] = useState<string>('[]')
  const [selectedUids, setSelectedUids] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ severity: 'success' | 'error' | 'info'; message: string } | null>(null)
  const [closeBlocked, setCloseBlocked] = useState(false)

  const [snapEnabled, setSnapEnabled] = useState(false)
  const [pxPerMs, setPxPerMs] = useState(0.05)

  const [audioDurationMs, setAudioDurationMs] = useState(0)
  // Optimistic: a background tab defers media loading, so waiting for
  // loadedmetadata would leave the transport looking broken.
  const [hasAudio, setHasAudio] = useState(true)
  const [isPlaying, setIsPlaying] = useState(false)
  const [playheadMs, setPlayheadMs] = useState(0)

  const [armedPattern, setArmedPattern] = useState<string | null>(null)
  const [dragGhost, setDragGhost] = useState<{ pattern: string; x: number; y: number } | null>(null)

  const [syncLights, setSyncLights] = useState(
    () => localStorage.getItem(LS_SYNC_LIGHTS) === 'true',
  )
  const [syncBusy, setSyncBusy] = useState(false)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const skipUnloadGuard = useRef(false)
  const dragPatternRef = useRef<string | null>(null)
  const playheadRef = useRef(0)

  const encoded = encodeURIComponent(basename)

  const snapMs = snapEnabled ? SNAP_STEP_MS : null

  const devices: TimelineDevice[] = useMemo(() => {
    const known = meta?.devices ?? []
    const byId = new Map(known.map((device) => [device.id, device]))
    // A timeline can target a device this server doesn't manage -- e.g.
    // generate_timeline.py emits bulb ids 2..5 regardless of what's set up.
    // Give those events a lane anyway so they stay visible and editable.
    for (const event of state.events) {
      if (!byId.has(event.id)) {
        byId.set(event.id, {
          id: event.id,
          name: event.id === 1 ? 'Main Light' : `Bulb ${event.id}`,
          kind: event.id === 1 ? 'strip' : 'bulb',
          managed: false,
        })
      }
    }
    return Array.from(byId.values()).sort((a, b) => a.id - b.id)
  }, [meta, state.events])

  // The inspector edits one event; a multi-selection gets the bulk panel.
  const selected = useMemo(
    () => (selectedUids.length === 1
      ? state.events.find((event) => event.uid === selectedUids[0]) ?? null
      : null),
    [state.events, selectedUids],
  )

  const selectOne = useCallback((uid: string | null, additive: boolean) => {
    setSelectedUids((current) => {
      if (uid === null) return []
      if (!additive) return [uid]
      return current.includes(uid) ? current.filter((item) => item !== uid) : [...current, uid]
    })
  }, [])

  const selectMany = useCallback((uids: string[], additive: boolean) => {
    setSelectedUids((current) => (additive ? Array.from(new Set([...current, ...uids])) : uids))
  }, [])

  const wire = useMemo(() => toWire(state.events), [state.events])
  const dirty = JSON.stringify(wire) !== baseline

  const totalMs = useMemo(() => {
    const lastEvent = state.events.reduce((max, event) => Math.max(max, event.end_ms), 0)
    return Math.max(30_000, audioDurationMs, lastEvent) + TAIL_PADDING_MS
  }, [state.events, audioDurationMs])

  // --- Loading -------------------------------------------------------------
  useEffect(() => {
    document.title = `Effects — ${basename}`
  }, [basename])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const [metaRes, timelineRes] = await Promise.all([
          fetch(`${API_BASE_URL}/api/effects/meta`),
          fetch(`${API_BASE_URL}/api/music/${encoded}/timeline`),
        ])
        if (!metaRes.ok) throw new Error(`could not load device metadata (${metaRes.status})`)
        if (!timelineRes.ok) {
          const body = await timelineRes.json().catch(() => ({}))
          throw new Error(body.error ?? `could not load timeline (${timelineRes.status})`)
        }
        const metaBody: EffectsMeta = await metaRes.json()
        const timelineBody = await timelineRes.json()
        if (cancelled) return

        const events = (timelineBody.events as unknown[]).map(fromWire)
        setMeta(metaBody)
        setState({ events, past: [], future: [] })
        setBaseline(JSON.stringify(toWire(events)))
        setLoadError(null)
        // Open zoomed out far enough to see the whole track at once.
        const lastEnd = events.reduce((max, event) => Math.max(max, event.end_ms), 0)
        const span = Math.max(30_000, lastEnd) + TAIL_PADDING_MS
        setPxPerMs(Math.max(MIN_PX_PER_MS, (window.innerWidth - 300) / span))
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [encoded])

  // --- Mutations -----------------------------------------------------------
  const mutate = useCallback(
    (updater: (events: EditorEvent[]) => EditorEvent[], recordHistory = true) => {
      setState((prev) => ({
        events: updater(prev.events),
        past: recordHistory ? [...prev.past.slice(-99), prev.events] : prev.past,
        future: recordHistory ? [] : prev.future,
      }))
    },
    [],
  )

  const patchEvents = useCallback(
    (updates: EventUpdate[], recordHistory = true) => {
      if (updates.length === 0) return
      const byUid = new Map(updates.map((update) => [update.uid, update.patch]))
      mutate(
        (events) =>
          events.map((event) => {
            const patch = byUid.get(event.uid)
            return patch ? { ...event, ...patch } : event
          }),
        recordHistory,
      )
    },
    [mutate],
  )

  const patchEvent = useCallback(
    (uid: string, patch: Partial<EditorEvent>) => patchEvents([{ uid, patch }]),
    [patchEvents],
  )

  const deleteEvents = useCallback(
    (uids: string[]) => {
      if (uids.length === 0) return
      const doomed = new Set(uids)
      mutate((events) => events.filter((event) => !doomed.has(event.uid)))
      setSelectedUids((current) => current.filter((uid) => !doomed.has(uid)))
    },
    [mutate],
  )

  const duplicateEvents = useCallback(
    (uids: string[]) => {
      const doomed = new Set(uids)
      const sources = state.events.filter((event) => doomed.has(event.uid))
      if (sources.length === 0) return
      // Drop the copies one full selection-width later so they don't land on
      // top of the originals.
      const span = Math.max(...sources.map((s) => s.end_ms)) - Math.min(...sources.map((s) => s.start_ms))
      const copies = sources.map((source) => ({
        ...source,
        uid: nextUid(),
        start_ms: source.start_ms + span,
        end_ms: source.end_ms + span,
        params: { ...source.params },
      }))
      mutate((events) => [...events, ...copies])
      setSelectedUids(copies.map((copy) => copy.uid))
    },
    [state.events, mutate],
  )

  const createEvent = useCallback(
    (deviceId: number, startMs: number, pattern: string) => {
      const duration = snapMs ? Math.max(snapMs, Math.round(NEW_EVENT_MS / snapMs) * snapMs) : NEW_EVENT_MS
      const start = Math.max(0, Math.round(snapMs ? Math.round(startMs / snapMs) * snapMs : startMs))
      const created: EditorEvent = {
        uid: nextUid(),
        id: deviceId,
        pattern,
        start_ms: start,
        end_ms: start + duration,
        segments: 'all',
        color: NEW_EVENT_COLOR,
        params: defaultParams(pattern, NEW_EVENT_COLOR),
      }
      mutate((events) => [...events, created])
      setSelectedUids([created.uid])
    },
    [mutate, snapMs],
  )

  const undo = useCallback(() => {
    setState((prev) => {
      if (prev.past.length === 0) return prev
      return {
        events: prev.past[prev.past.length - 1],
        past: prev.past.slice(0, -1),
        future: [prev.events, ...prev.future].slice(0, 100),
      }
    })
  }, [])

  const redo = useCallback(() => {
    setState((prev) => {
      if (prev.future.length === 0) return prev
      return {
        events: prev.future[0],
        past: [...prev.past.slice(-99), prev.events],
        future: prev.future.slice(1),
      }
    })
  }, [])

  // --- Light sync ----------------------------------------------------------
  useEffect(() => {
    localStorage.setItem(LS_SYNC_LIGHTS, syncLights ? 'true' : 'false')
  }, [syncLights])

  const stopPreview = useCallback((keepalive = false) => {
    // Best effort: the server also drops the preview if anything else takes
    // the lights, and the renderer exits on its own at the end of the timeline.
    void fetch(`${API_BASE_URL}/api/music/preview/stop`, { method: 'POST', keepalive }).catch(
      () => undefined,
    )
  }, [])

  // --- Save / cancel -------------------------------------------------------
  const handleSave = useCallback(async () => {
    setSaving(true)
    const payload = toWire(state.events)
    try {
      const res = await fetch(`${API_BASE_URL}/api/music/${encoded}/timeline`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: payload }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setToast({ severity: 'error', message: body.error ?? `Save failed (${res.status})` })
        return
      }
      setBaseline(JSON.stringify(payload))
      setToast({
        severity: 'success',
        message: body.restart_required
          ? `Saved ${payload.length} events — restart the track to hear the changes`
          : `Saved ${payload.length} events to ${basename}.json`,
      })
    } catch (err) {
      setToast({ severity: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving(false)
    }
  }, [state.events, encoded, basename])

  const handleCancel = useCallback(() => {
    if (dirty && !window.confirm('You have unsaved changes. Close the editor and discard them?')) {
      return
    }
    skipUnloadGuard.current = true
    audioRef.current?.pause()
    stopPreview()
    window.close()
    // A tab the user opened manually can't be closed by script.
    window.setTimeout(() => setCloseBlocked(true), 250)
  }, [dirty, stopPreview])

  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (!dirty || skipUnloadGuard.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    // Don't leave the room lit by a preview nobody is watching.
    const release = () => stopPreview(true)
    window.addEventListener('beforeunload', guard)
    window.addEventListener('pagehide', release)
    return () => {
      window.removeEventListener('beforeunload', guard)
      window.removeEventListener('pagehide', release)
    }
  }, [dirty, stopPreview])

  // --- Audio preview -------------------------------------------------------
  useEffect(() => {
    playheadRef.current = playheadMs
  }, [playheadMs])

  useEffect(() => {
    if (!isPlaying) return
    let frame = 0
    const tick = () => {
      const audio = audioRef.current
      if (audio) setPlayheadMs(audio.currentTime * 1000)
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [isPlaying])

  const startPreview = useCallback(
    async (atMs: number): Promise<boolean> => {
      setSyncBusy(true)
      try {
        const res = await fetch(`${API_BASE_URL}/api/music/${encoded}/preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Send what's on screen, so unsaved edits can be watched on the wall.
          body: JSON.stringify({ start_ms: Math.round(atMs), events: toWire(state.events) }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          setToast({ severity: 'error', message: body.error ?? `Light sync failed (${res.status})` })
          return false
        }
        return true
      } catch (err) {
        setToast({ severity: 'error', message: err instanceof Error ? err.message : String(err) })
        return false
      } finally {
        setSyncBusy(false)
      }
    },
    [encoded, state.events],
  )

  const seekRestartRef = useRef<number | null>(null)

  const handleSeek = useCallback(
    (ms: number) => {
      const clamped = Math.max(0, ms)
      setPlayheadMs(clamped)
      const audio = audioRef.current
      if (audio && Number.isFinite(audio.duration)) {
        audio.currentTime = Math.min(clamped / 1000, audio.duration)
      }
      // Seeking mid-playback means relaunching the renderer at the new offset;
      // debounce so scrubbing doesn't spawn one per frame.
      if (syncLights && audio && !audio.paused) {
        if (seekRestartRef.current !== null) window.clearTimeout(seekRestartRef.current)
        seekRestartRef.current = window.setTimeout(() => {
          seekRestartRef.current = null
          void startPreview(clamped)
        }, 400)
      }
    },
    [syncLights, startPreview],
  )

  const handleTogglePlay = useCallback(async () => {
    const audio = audioRef.current
    if (!audio) return
    if (!audio.paused) {
      audio.pause()
      return
    }
    if (Number.isFinite(audio.duration) && Math.abs(audio.currentTime * 1000 - playheadMs) > 50) {
      audio.currentTime = Math.min(playheadMs / 1000, audio.duration)
    }
    // Wait for the renderer to be warmed up before the song starts, otherwise
    // the lights come in late by however long the waveform took to load.
    if (syncLights && !(await startPreview(playheadMs))) return
    void audio.play().catch(() => setHasAudio(false))
  }, [syncLights, startPreview, playheadMs])

  const handleSyncLightsChange = useCallback(
    (next: boolean) => {
      setSyncLights(next)
      const audio = audioRef.current
      const playing = !!audio && !audio.paused
      if (next && playing) void startPreview(audio.currentTime * 1000)
      if (!next) stopPreview()
    },
    [startPreview, stopPreview],
  )

  // --- Drag from the palette ----------------------------------------------
  const startPaletteDrag = useCallback((pattern: string, x: number, y: number) => {
    dragPatternRef.current = pattern
    setDragGhost({ pattern, x, y })
  }, [])

  const isDragging = dragGhost !== null
  useEffect(() => {
    if (!isDragging) return

    const move = (e: PointerEvent) => {
      e.preventDefault()
      setDragGhost((current) => (current ? { ...current, x: e.clientX, y: e.clientY } : current))
    }

    const drop = (e: PointerEvent) => {
      const pattern = dragPatternRef.current
      dragPatternRef.current = null
      setDragGhost(null)
      if (!pattern) return
      // The ghost is pointer-events:none, so this hits the lane underneath.
      const target = document.elementFromPoint(e.clientX, e.clientY)
      const lane = target?.closest('[data-lane-id]') as HTMLElement | null
      if (!lane) return
      const deviceId = Number(lane.dataset.laneId)
      if (!Number.isFinite(deviceId)) return
      const rect = lane.getBoundingClientRect()
      createEvent(deviceId, Math.max(0, (e.clientX - rect.left) / pxPerMs), pattern)
      setArmedPattern(null)
    }

    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', drop)
    window.addEventListener('pointercancel', drop)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', drop)
      window.removeEventListener('pointercancel', drop)
    }
  }, [isDragging, createEvent, pxPerMs])

  const handleLaneClick = useCallback(
    (deviceId: number, ms: number) => {
      if (armedPattern) {
        // createEvent snaps to the beat grid itself.
        createEvent(deviceId, ms, armedPattern)
        setArmedPattern(null)
        return
      }
      setSelectedUids([])
      handleSeek(ms)
    },
    [armedPattern, createEvent, handleSeek],
  )

  // --- Keyboard ------------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      // Sliders and open dropdowns own the arrow keys; leave them alone.
      const typing =
        !!target &&
        (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
          !!target.closest('[role="listbox"], [role="menu"], [role="combobox"], [role="slider"]'))
      const modifier = e.metaKey || e.ctrlKey

      if (modifier && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (dirty && !saving) void handleSave()
        return
      }
      if (modifier && e.key.toLowerCase() === 'z') {
        if (typing) return
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (typing) return

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        // Nudging is for lining an event up against a moment in the song, so
        // stop playback rather than fight a moving playhead -- it stays parked
        // wherever the arrows leave it. (Also drops the light preview.)
        audioRef.current?.pause()
        // Fine nudge by default, coarse with Shift. Read the live position
        // from the ref so playback doesn't re-register this listener 60x/s.
        const step = e.shiftKey ? COARSE_NUDGE_MS : SNAP_STEP_MS
        const direction = e.key === 'ArrowRight' ? 1 : -1
        handleSeek(Math.max(0, playheadRef.current + direction * step))
        return
      }
      if (modifier && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setSelectedUids(state.events.map((event) => event.uid))
        return
      }
      if (modifier && e.key.toLowerCase() === 'd' && selectedUids.length) {
        e.preventDefault()
        duplicateEvents(selectedUids)
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedUids.length) {
        e.preventDefault()
        deleteEvents(selectedUids)
        return
      }
      if (e.key === 'Escape') {
        setArmedPattern(null)
        setSelectedUids([])
        return
      }
      if (e.key === ' ') {
        e.preventDefault()
        void handleTogglePlay()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    dirty,
    saving,
    selectedUids,
    state.events,
    handleSave,
    handleTogglePlay,
    handleSeek,
    undo,
    redo,
    duplicateEvents,
    deleteEvents,
  ])

  const zoomBy = useCallback((direction: 1 | -1) => {
    setPxPerMs((current) =>
      Math.min(MAX_PX_PER_MS, Math.max(MIN_PX_PER_MS, current * (direction === 1 ? 1.45 : 1 / 1.45))),
    )
  }, [])

  const zoomFit = useCallback(() => {
    setPxPerMs(Math.max(MIN_PX_PER_MS, (window.innerWidth - 300) / totalMs))
  }, [totalMs])

  if (loading) {
    return (
      <ThemeProvider theme={editorTheme}>
        <CssBaseline />
        <Stack sx={{ height: '100vh', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
          <CircularProgress size={28} />
          <Typography sx={{ color: 'text.secondary' }}>Loading {basename}…</Typography>
        </Stack>
      </ThemeProvider>
    )
  }

  if (loadError) {
    return (
      <ThemeProvider theme={editorTheme}>
        <CssBaseline />
        <Stack sx={{ height: '100vh', alignItems: 'center', justifyContent: 'center', gap: 2, p: 4 }}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            Can't Open the Effect Editor
          </Typography>
          <Typography sx={{ color: 'text.secondary', textAlign: 'center', maxWidth: 460 }}>
            {loadError}
          </Typography>
          <Button variant="outlined" onClick={() => window.close()} sx={{ textTransform: 'none', borderRadius: 2 }}>
            Close Tab
          </Button>
        </Stack>
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider theme={editorTheme}>
      <CssBaseline />
      <Box
        sx={{
          height: '100vh',
          display: 'grid',
          // The timeline sizes to its lanes instead of taking the leftover
          // height -- with only a few devices it was leaving dead space below
          // them. Capped so a long device list can't crowd out the panels.
          gridTemplateRows: 'auto minmax(200px, 1fr) auto',
          gap: 1.5,
          p: 1.5,
          boxSizing: 'border-box',
        }}
      >
        <Stack
          direction="row"
          sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 2, px: 0.5, flexWrap: 'wrap' }}
        >
          <Stack direction="row" sx={{ alignItems: 'center', gap: 1.5, minWidth: 0 }}>
            <Typography variant="h6" sx={{ fontWeight: 700 }} noWrap>
              {basename}
            </Typography>
            <Chip
              label={`${state.events.length} Events`}
              size="small"
              sx={{
                height: 22,
                backgroundColor: alpha('#ffffff', 0.06),
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            />
            {armedPattern && (
              <Chip
                label={`Tap a Lane to Place ${patternLabel(armedPattern)}`}
                size="small"
                onDelete={() => setArmedPattern(null)}
                sx={{
                  height: 22,
                  color: '#8ab4ff',
                  backgroundColor: alpha('#8ab4ff', 0.14),
                  border: '1px solid rgba(138,180,255,0.3)',
                }}
              />
            )}
          </Stack>

          <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5 }}>
            <Tooltip title="Undo (⌘Z)">
              <span>
                <IconButton size="small" onClick={undo} disabled={state.past.length === 0}>
                  <UndoRounded fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Redo (⇧⌘Z)">
              <span>
                <IconButton size="small" onClick={redo} disabled={state.future.length === 0}>
                  <RedoRounded fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Typography variant="caption" sx={{ color: 'text.secondary', ml: 1 }}>
              Drag to Move · Edges to Resize · ⌥Drag to Select · ←→ to Seek · Del to Remove
            </Typography>
          </Stack>
        </Stack>

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: 'minmax(240px, 300px) 1fr' },
            gap: 1.5,
            minHeight: 0,
          }}
        >
          <Box sx={panelSx}>
            <EffectPalette
              onDragStart={startPaletteDrag}
              armedPattern={armedPattern}
              onArm={setArmedPattern}
              draggingPattern={dragGhost?.pattern ?? null}
            />
          </Box>
          <Box sx={panelSx}>
            <EffectInspector
              event={selected}
              selectionCount={selectedUids.length}
              onClearSelection={() => setSelectedUids([])}
              devices={devices}
              zones={meta?.zones ?? []}
              pixels={meta?.pixels ?? 45}
              snapMs={snapMs}
              dirty={dirty}
              saving={saving}
              playheadMs={playheadMs}
              onChange={(patch) => selected && patchEvent(selected.uid, patch)}
              onDuplicate={() => duplicateEvents(selectedUids)}
              onDelete={() => deleteEvents(selectedUids)}
              onSave={() => void handleSave()}
              onCancel={handleCancel}
            />
          </Box>
        </Box>

        <Box sx={{ ...panelSx, maxHeight: '55vh' }}>
          <EffectTimeline
            events={state.events}
            devices={devices}
            selectedUids={selectedUids}
            totalMs={totalMs}
            pxPerMs={pxPerMs}
            snapMs={snapMs}
            snapEnabled={snapEnabled}
            onSnapChange={setSnapEnabled}
            playheadMs={playheadMs}
            isPlaying={isPlaying}
            hasAudio={hasAudio}
            syncLights={syncLights}
            syncBusy={syncBusy}
            onSyncLightsChange={handleSyncLightsChange}
            armedPattern={armedPattern}
            onSelect={selectOne}
            onSelectMany={selectMany}
            onEventsMutate={patchEvents}
            onLaneClick={handleLaneClick}
            onSeek={handleSeek}
            onTogglePlay={() => void handleTogglePlay()}
            onZoom={zoomBy}
            onZoomFit={zoomFit}
          />
        </Box>
      </Box>

      <audio
        ref={audioRef}
        src={`${API_BASE_URL}/api/music/${encoded}/audio`}
        preload="metadata"
        onLoadedMetadata={(e) => {
          setHasAudio(true)
          const seconds = (e.target as HTMLAudioElement).duration
          if (Number.isFinite(seconds)) setAudioDurationMs(seconds * 1000)
        }}
        onError={() => setHasAudio(false)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => {
          setIsPlaying(false)
          if (syncLights) stopPreview()
        }}
        onEnded={() => {
          setIsPlaying(false)
          if (syncLights) stopPreview()
        }}
      />

      {dragGhost && (
        <Box
          sx={{
            position: 'fixed',
            left: dragGhost.x + 12,
            top: dragGhost.y + 12,
            px: 1.25,
            py: 0.5,
            borderRadius: 1,
            pointerEvents: 'none',
            zIndex: 1400,
            fontSize: '0.78rem',
            fontWeight: 700,
            color: '#06070b',
            background: '#8ab4ff',
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          }}
        >
          {patternLabel(dragGhost.pattern)}
        </Box>
      )}

      <Snackbar
        open={!!toast}
        autoHideDuration={toast?.severity === 'error' ? 8000 : 4000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={toast?.severity ?? 'info'} variant="filled" onClose={() => setToast(null)}>
          {toast?.message}
        </Alert>
      </Snackbar>

      <Snackbar
        open={closeBlocked}
        autoHideDuration={6000}
        onClose={() => setCloseBlocked(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="info" variant="filled" onClose={() => setCloseBlocked(false)}>
          Your browser blocked closing this tab — close it manually.
        </Alert>
      </Snackbar>
    </ThemeProvider>
  )
}

export default EffectEditor
