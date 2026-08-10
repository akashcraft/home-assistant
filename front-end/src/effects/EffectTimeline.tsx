import { useEffect, useMemo, useRef } from 'react'
import {
  alpha,
  Box,
  CircularProgress,
  FormControlLabel,
  IconButton,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from '@mui/material'
import {
  FitScreenRounded,
  PauseRounded,
  PlayArrowRounded,
  ZoomInRounded,
  ZoomOutRounded,
} from '@mui/icons-material'
import {
  formatClock,
  isLight,
  patternLabel,
  rgbCss,
  type EditorEvent,
  type TimelineDevice,
} from './effectSchema'

/** Fixed grid the Snap toggle rounds to. */
export const SNAP_STEP_MS = 100

export const LANE_HEIGHT = 56
const RULER_HEIGHT = 30
const GUTTER_WIDTH = 132
const MIN_EVENT_MS = 50
const RESIZE_GRIP_PX = 9

const TICK_STEPS = [100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000]

/** Original geometry of one event being dragged, so a group move can apply
 *  the same delta to every member without compounding rounding. */
type DragMember = {
  uid: string
  start: number
  end: number
  deviceIndex: number
}

type DragState = {
  uid: string
  mode: 'move' | 'resize-start' | 'resize-end'
  pointerX: number
  pointerY: number
  origStart: number
  origEnd: number
  origDeviceIndex: number
  moved: boolean
  group: DragMember[]
}

type MarqueeState = {
  pointerId: number
  startX: number
  startY: number
  deviceId: number
  additive: boolean
  active: boolean
}

export type EventUpdate = { uid: string; patch: Partial<EditorEvent> }

type EffectTimelineProps = {
  events: EditorEvent[]
  devices: TimelineDevice[]
  selectedUids: string[]
  totalMs: number
  pxPerMs: number
  snapMs: number | null
  playheadMs: number
  isPlaying: boolean
  hasAudio: boolean
  syncLights: boolean
  syncBusy: boolean
  onSyncLightsChange: (next: boolean) => void
  snapEnabled: boolean
  onSnapChange: (next: boolean) => void
  armedPattern: string | null
  onSelect: (uid: string | null, additive: boolean) => void
  onSelectMany: (uids: string[], additive: boolean) => void
  onEventsMutate: (updates: EventUpdate[], recordHistory: boolean) => void
  onLaneClick: (deviceId: number, ms: number) => void
  onSeek: (ms: number) => void
  onTogglePlay: () => void
  onZoom: (direction: 1 | -1) => void
  onZoomFit: () => void
}

function EffectTimeline({
  events,
  devices,
  selectedUids,
  totalMs,
  pxPerMs,
  snapMs,
  playheadMs,
  isPlaying,
  hasAudio,
  syncLights,
  syncBusy,
  onSyncLightsChange,
  snapEnabled,
  onSnapChange,
  armedPattern,
  onSelect,
  onSelectMany,
  onEventsMutate,
  onLaneClick,
  onSeek,
  onTogglePlay,
  onZoom,
  onZoomFit,
}: EffectTimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const ghostRef = useRef<HTMLDivElement | null>(null)
  const ghostLabelRef = useRef<HTMLSpanElement | null>(null)
  const lanesRef = useRef<HTMLDivElement | null>(null)
  const marqueeRef = useRef<HTMLDivElement | null>(null)
  const marqueeStateRef = useRef<MarqueeState | null>(null)

  const selectedSet = useMemo(() => new Set(selectedUids), [selectedUids])

  const totalPx = Math.max(320, totalMs * pxPerMs)

  const eventsByDevice = useMemo(() => {
    const map = new Map<number, EditorEvent[]>()
    for (const device of devices) map.set(device.id, [])
    for (const event of events) {
      if (!map.has(event.id)) map.set(event.id, [])
      map.get(event.id)!.push(event)
    }
    for (const list of map.values()) list.sort((a, b) => a.start_ms - b.start_ms)
    return map
  }, [events, devices])

  /** The player takes the *last* matching event, so overlaps silently hide
   *  work. Flag them rather than preventing them. */
  const overlapping = useMemo(() => {
    const flagged = new Set<string>()
    for (const list of eventsByDevice.values()) {
      for (let i = 1; i < list.length; i += 1) {
        if (list[i].start_ms < list[i - 1].end_ms) {
          flagged.add(list[i].uid)
          flagged.add(list[i - 1].uid)
        }
      }
    }
    return flagged
  }, [eventsByDevice])

  const ticks = useMemo(() => {
    const step = TICK_STEPS.find((candidate) => candidate * pxPerMs >= 72) ?? TICK_STEPS[TICK_STEPS.length - 1]
    const out: number[] = []
    for (let ms = 0; ms <= totalMs; ms += step) out.push(ms)
    return { step, values: out }
  }, [pxPerMs, totalMs])

  // Keep the playhead on screen during playback without fighting manual scroll.
  useEffect(() => {
    if (!isPlaying) return
    const el = scrollRef.current
    if (!el) return
    const x = playheadMs * pxPerMs
    if (x < el.scrollLeft + 40 || x > el.scrollLeft + el.clientWidth - 80) {
      el.scrollLeft = Math.max(0, x - el.clientWidth / 3)
    }
  }, [playheadMs, pxPerMs, isPlaying])

  const snap = (ms: number) => (snapMs ? Math.round(ms / snapMs) * snapMs : Math.round(ms))

  const handleEventPointerDown = (event: EditorEvent, e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // Alt-drag rubber-bands even when starting on top of an event -- a busy
    // lane can be wall-to-wall with no empty space to start from.
    if (e.altKey) return
    e.stopPropagation()

    const additive = e.shiftKey || e.metaKey || e.ctrlKey
    // Grabbing an event that's already part of a selection drags the whole
    // set; grabbing anything else collapses the selection onto it first.
    const inSelection = selectedSet.has(event.uid)
    if (additive || !inSelection) onSelect(event.uid, additive)
    const groupUids = !additive && inSelection && selectedSet.size > 1 ? selectedSet : new Set([event.uid])

    const rect = e.currentTarget.getBoundingClientRect()
    const offsetX = e.clientX - rect.left
    const canResize = rect.width > RESIZE_GRIP_PX * 2.5
    const mode: DragState['mode'] = !canResize
      ? 'move'
      : offsetX <= RESIZE_GRIP_PX
        ? 'resize-start'
        : offsetX >= rect.width - RESIZE_GRIP_PX
          ? 'resize-end'
          : 'move'

    dragRef.current = {
      uid: event.uid,
      mode,
      pointerX: e.clientX,
      pointerY: e.clientY,
      origStart: event.start_ms,
      origEnd: event.end_ms,
      origDeviceIndex: Math.max(0, devices.findIndex((d) => d.id === event.id)),
      moved: false,
      group: events
        .filter((candidate) => groupUids.has(candidate.uid))
        .map((candidate) => ({
          uid: candidate.uid,
          start: candidate.start_ms,
          end: candidate.end_ms,
          deviceIndex: Math.max(0, devices.findIndex((d) => d.id === candidate.id)),
        })),
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const handleEventPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const dx = e.clientX - drag.pointerX
    const dy = e.clientY - drag.pointerY
    if (!drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return

    const recordHistory = !drag.moved
    drag.moved = true
    const deltaMs = dx / pxPerMs

    if (drag.mode === 'move') {
      // Derive the delta from the grabbed event (so it lands on the grid),
      // then shift the rest of the group by exactly the same amount.
      const start = Math.max(0, snap(Math.max(0, drag.origStart + deltaMs)))
      const appliedDelta = start - drag.origStart
      const laneShift = Math.round(dy / LANE_HEIGHT)

      onEventsMutate(
        drag.group.map((member) => {
          const memberStart = Math.max(0, member.start + appliedDelta)
          const patch: Partial<EditorEvent> = {
            start_ms: memberStart,
            end_ms: memberStart + (member.end - member.start),
          }
          const targetIndex = Math.max(0, Math.min(devices.length - 1, member.deviceIndex + laneShift))
          const targetDevice = devices[targetIndex]
          if (targetDevice) patch.id = targetDevice.id
          return { uid: member.uid, patch }
        }),
        recordHistory,
      )
      return
    }

    // Resizing stays single-event -- stretching a whole selection by one
    // edge is rarely what's meant.
    if (drag.mode === 'resize-start') {
      const start = Math.max(0, Math.min(snap(drag.origStart + deltaMs), drag.origEnd - MIN_EVENT_MS))
      onEventsMutate([{ uid: drag.uid, patch: { start_ms: start } }], recordHistory)
      return
    }

    const end = Math.max(snap(drag.origEnd + deltaMs), drag.origStart + MIN_EVENT_MS)
    onEventsMutate([{ uid: drag.uid, patch: { end_ms: end } }], recordHistory)
  }

  /** The hover head is written straight to the DOM: it follows every mouse
   *  move, and re-rendering a few hundred event blocks that often would
   *  visibly stutter. */
  const moveGhost = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return
    const surface = surfaceRef.current
    const ghost = ghostRef.current
    if (!surface || !ghost) return
    const x = e.clientX - surface.getBoundingClientRect().left
    if (x < 0 || x > surface.offsetWidth) {
      ghost.style.opacity = '0'
      return
    }
    ghost.style.opacity = '1'
    ghost.style.transform = `translateX(${x}px)`
    if (ghostLabelRef.current) {
      ghostLabelRef.current.textContent = formatClock(x / pxPerMs, true)
    }
  }

  const hideGhost = () => {
    if (ghostRef.current) ghostRef.current.style.opacity = '0'
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current && e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    dragRef.current = null
  }

  // --- Marquee selection ---------------------------------------------------
  // A press on empty lane space is ambiguous until the pointer moves: a drag
  // rubber-bands a selection, a plain click seeks. So the seek waits for
  // pointerup, and the rectangle is drawn straight to the DOM to keep every
  // event block out of the re-render path while dragging.

  const marqueeBox = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = marqueeStateRef.current
    const lanes = lanesRef.current
    if (!state || !lanes) return null
    const rect = lanes.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    return {
      left: Math.min(state.startX, x),
      right: Math.max(state.startX, x),
      top: Math.min(state.startY, y),
      bottom: Math.max(state.startY, y),
    }
  }

  const handleLanesPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Event blocks stop propagation, so anything arriving here is empty space.
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const lanes = lanesRef.current
    if (!lanes) return
    const laneEl = (e.target as HTMLElement).closest('[data-lane-id]') as HTMLElement | null
    if (!laneEl) return

    const rect = lanes.getBoundingClientRect()
    marqueeStateRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top,
      deviceId: Number(laneEl.dataset.laneId),
      additive: e.shiftKey || e.metaKey || e.ctrlKey,
      active: false,
    }
    try {
      lanes.setPointerCapture(e.pointerId)
    } catch {
      // Pointer already released; plain bubbling still drives the marquee.
    }
  }

  const handleLanesPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = marqueeStateRef.current
    const box = marqueeBox(e)
    const el = marqueeRef.current
    if (!state || !box || !el) return
    if (!state.active && box.right - box.left < 4 && box.bottom - box.top < 4) return
    state.active = true
    el.style.display = 'block'
    el.style.left = `${box.left}px`
    el.style.top = `${box.top}px`
    el.style.width = `${box.right - box.left}px`
    el.style.height = `${box.bottom - box.top}px`
  }

  const handleLanesPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = marqueeStateRef.current
    const box = marqueeBox(e)
    if (marqueeRef.current) marqueeRef.current.style.display = 'none'
    try {
      if (state && lanesRef.current?.hasPointerCapture(state.pointerId)) {
        lanesRef.current.releasePointerCapture(state.pointerId)
      }
    } catch {
      // Nothing to release.
    }
    marqueeStateRef.current = null
    if (!state || !box) return

    if (!state.active) {
      onLaneClick(state.deviceId, Math.max(0, box.left / pxPerMs))
      return
    }

    const fromMs = box.left / pxPerMs
    const toMs = box.right / pxPerMs
    const firstLane = Math.floor(box.top / LANE_HEIGHT)
    const lastLane = Math.floor(box.bottom / LANE_HEIGHT)
    const laneIds = new Set(
      devices.slice(Math.max(0, firstLane), lastLane + 1).map((device) => device.id),
    )
    const hits = events
      .filter((event) => laneIds.has(event.id) && event.start_ms < toMs && event.end_ms > fromMs)
      .map((event) => event.uid)
    onSelectMany(hits, state.additive)
  }

  return (
    <Stack sx={{ height: '100%', minHeight: 0 }}>
      <Stack
        direction="row"
        sx={{
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1.5,
          px: 2,
          py: 1.25,
          flexWrap: 'wrap',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <Stack direction="row" sx={{ alignItems: 'center', gap: 1.25 }}>
          <Typography sx={{ fontWeight: 700 }}>Timeline</Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {events.length} Event{events.length === 1 ? '' : 's'}
            {overlapping.size > 0 ? ` · ${overlapping.size} Overlapping` : ''}
          </Typography>
        </Stack>

        <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5 }}>
          <Tooltip title="Run the timeline on the real lights while the song plays here">
            <FormControlLabel
              sx={{ mr: 0.5 }}
              control={
                <Switch
                  size="small"
                  checked={syncLights}
                  onChange={(e) => onSyncLightsChange(e.target.checked)}
                />
              }
              label={
                <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5 }}>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    Sync Lights
                  </Typography>
                  {syncBusy && <CircularProgress size={12} thickness={6} />}
                </Stack>
              }
            />
          </Tooltip>
          <Tooltip title={`Round moves, resizes and new events to ${SNAP_STEP_MS} ms`}>
            <FormControlLabel
              sx={{ ml: 1.5, mr: 0.5 }}
              control={
                <Switch
                  size="small"
                  checked={snapEnabled}
                  onChange={(e) => onSnapChange(e.target.checked)}
                />
              }
              label={
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                  Snap
                </Typography>
              }
            />
          </Tooltip>
          <Tooltip title={hasAudio ? 'Play / Pause Preview (Space)' : 'Audio Unavailable'}>
            <span>
              <IconButton size="small" onClick={onTogglePlay} disabled={!hasAudio}>
                {isPlaying ? <PauseRounded fontSize="small" /> : <PlayArrowRounded fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
          <Typography
            variant="caption"
            sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums', minWidth: 92, textAlign: 'center' }}
          >
            {formatClock(playheadMs, true)}
          </Typography>
          <Tooltip title="Zoom Out">
            <IconButton size="small" onClick={() => onZoom(-1)}>
              <ZoomOutRounded fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Zoom In">
            <IconButton size="small" onClick={() => onZoom(1)}>
              <ZoomInRounded fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Fit Whole Track">
            <IconButton size="small" onClick={onZoomFit}>
              <FitScreenRounded fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', overflowY: 'auto' }}>
        {/* Fixed gutter: lane names stay put while the timeline scrolls sideways. */}
        <Box sx={{ width: GUTTER_WIDTH, flexShrink: 0, borderRight: '1px solid rgba(255,255,255,0.08)' }}>
          <Box sx={{ height: RULER_HEIGHT, borderBottom: '1px solid rgba(255,255,255,0.08)' }} />
          {devices.map((device) => (
            <Stack
              key={device.id}
              sx={{
                height: LANE_HEIGHT,
                px: 1.5,
                justifyContent: 'center',
                borderBottom: '1px solid rgba(255,255,255,0.05)',
              }}
            >
              <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
                {device.name}
              </Typography>
              <Typography
                variant="caption"
                sx={{ color: device.managed ? 'text.secondary' : '#e0a35c' }}
                noWrap
                title={device.managed ? undefined : 'This timeline targets a device the server has no entry for'}
              >
                {device.kind === 'strip' ? `Strip · ID ${device.id}` : `Bulb · ID ${device.id}`}
                {device.managed ? '' : ' · Not Set Up'}
              </Typography>
            </Stack>
          ))}
        </Box>

        <Box ref={scrollRef} sx={{ flex: 1, minWidth: 0, overflowX: 'auto', overflowY: 'hidden' }}>
          <Box
            ref={surfaceRef}
            onPointerMove={moveGhost}
            onPointerLeave={hideGhost}
            sx={{ position: 'relative', width: totalPx }}
          >
            <Box
              onPointerDown={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                onSeek(Math.max(0, (e.clientX - rect.left) / pxPerMs))
              }}
              sx={{
                position: 'relative',
                height: RULER_HEIGHT,
                borderBottom: '1px solid rgba(255,255,255,0.08)',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              {ticks.values.map((ms) => (
                <Box
                  key={ms}
                  sx={{
                    position: 'absolute',
                    left: ms * pxPerMs,
                    top: 0,
                    bottom: 0,
                    borderLeft: '1px solid rgba(255,255,255,0.10)',
                    pl: 0.5,
                    display: 'flex',
                    alignItems: 'center',
                    pointerEvents: 'none',
                  }}
                >
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
                    {formatClock(ms, ticks.step < 1000)}
                  </Typography>
                </Box>
              ))}
            </Box>

            <Box
              ref={lanesRef}
              onPointerDown={handleLanesPointerDown}
              onPointerMove={handleLanesPointerMove}
              onPointerUp={handleLanesPointerUp}
              onPointerCancel={handleLanesPointerUp}
              sx={{ position: 'relative', touchAction: 'pan-x pan-y' }}
            >
              {devices.map((device) => {
                const laneEvents = eventsByDevice.get(device.id) ?? []
                return (
                  <Box
                    key={device.id}
                    data-lane-id={device.id}
                    sx={{
                      position: 'relative',
                      height: LANE_HEIGHT,
                      borderBottom: '1px solid rgba(255,255,255,0.05)',
                      cursor: armedPattern ? 'copy' : 'default',
                      background:
                        snapMs && snapMs * pxPerMs > 6
                          ? `repeating-linear-gradient(to right, rgba(255,255,255,0.05) 0 1px, transparent 1px ${snapMs * pxPerMs}px)`
                          : 'transparent',
                    }}
                  >
                    {laneEvents.map((event) => {
                      const left = event.start_ms * pxPerMs
                      const width = Math.max(3, (event.end_ms - event.start_ms) * pxPerMs)
                      const selected = selectedSet.has(event.uid)
                      const base = rgbCss(event.color)
                      const showLabel = width > 46
                      return (
                        <Box
                          key={event.uid}
                          onPointerDown={(e) => handleEventPointerDown(event, e)}
                          onPointerMove={handleEventPointerMove}
                          onPointerUp={endDrag}
                          onPointerCancel={endDrag}
                          title={`${patternLabel(event.pattern)} · ${formatClock(event.start_ms, true)} → ${formatClock(
                            event.end_ms,
                            true,
                          )}${device.kind === 'strip' ? ` · ${event.segments}` : ''}`}
                          sx={{
                            position: 'absolute',
                            left,
                            width,
                            top: 6,
                            height: LANE_HEIGHT - 14,
                            borderRadius: 1,
                            px: 0.75,
                            display: 'flex',
                            alignItems: 'center',
                            overflow: 'hidden',
                            touchAction: 'none',
                            userSelect: 'none',
                            cursor: 'grab',
                            background: `linear-gradient(180deg, ${alpha(base, 0.95)}, ${alpha(base, 0.6)})`,
                            border: selected
                              ? '2px solid #ffffff'
                              : overlapping.has(event.uid)
                                ? '1px solid rgba(255,120,120,0.9)'
                                : '1px solid rgba(0,0,0,0.35)',
                            boxShadow: selected ? '0 0 0 1px rgba(0,0,0,0.6), 0 6px 18px rgba(0,0,0,0.45)' : 'none',
                            zIndex: selected ? 2 : 1,
                          }}
                        >
                          {showLabel && (
                            <Typography
                              variant="caption"
                              noWrap
                              sx={{
                                fontWeight: 700,
                                pointerEvents: 'none',
                                color: isLight(event.color) ? 'rgba(0,0,0,0.82)' : '#ffffff',
                                textShadow: isLight(event.color) ? 'none' : '0 1px 2px rgba(0,0,0,0.5)',
                              }}
                            >
                              {patternLabel(event.pattern)}
                            </Typography>
                          )}
                        </Box>
                      )
                    })}
                  </Box>
                )
              })}

              <Box
                ref={marqueeRef}
                sx={{
                  position: 'absolute',
                  display: 'none',
                  pointerEvents: 'none',
                  borderRadius: 0.5,
                  border: '1px solid rgba(138,180,255,0.9)',
                  background: alpha('#8ab4ff', 0.16),
                  zIndex: 5,
                }}
              />
            </Box>

            {/* Ghost head: where a click would drop the playhead. */}
            <Box
              ref={ghostRef}
              sx={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: 0,
                borderLeft: '1px dashed rgba(255,255,255,0.55)',
                opacity: 0,
                pointerEvents: 'none',
                willChange: 'transform',
                zIndex: 4,
              }}
            >
              <Box
                component="span"
                ref={ghostLabelRef}
                sx={{
                  position: 'absolute',
                  top: 2,
                  left: 4,
                  px: 0.5,
                  borderRadius: 0.5,
                  fontSize: '0.68rem',
                  fontVariantNumeric: 'tabular-nums',
                  whiteSpace: 'nowrap',
                  color: '#0b0d12',
                  background: 'rgba(255,255,255,0.72)',
                }}
              />
            </Box>

            <Box
              sx={{
                position: 'absolute',
                left: playheadMs * pxPerMs,
                top: 0,
                bottom: 0,
                width: 2,
                marginLeft: '-1px',
                background: '#ff5f5f',
                pointerEvents: 'none',
                zIndex: 3,
              }}
            />
          </Box>
        </Box>
      </Box>
    </Stack>
  )
}

export default EffectTimeline
