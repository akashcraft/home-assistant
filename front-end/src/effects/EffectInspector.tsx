import { useMemo, useState } from 'react'
import {
  alpha,
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  MenuItem,
  Select,
  Slider,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material'
import {
  AddRounded,
  CloseRounded,
  ContentCopyRounded,
  DeleteOutlineRounded,
  SaveRounded,
} from '@mui/icons-material'
import {
  PATTERN_BY_NAME,
  PATTERN_SPECS,
  defaultParams,
  formatClock,
  hexToRgb,
  indicesToText,
  parseSegments,
  resolveParamDefault,
  rgbCss,
  rgbToHex,
  segmentMode,
  toRgb,
  type EditorEvent,
  type ParamSpec,
  type RGB,
  type SegmentMode,
  type StripZone,
  type TimelineDevice,
} from './effectSchema'

// Straight ROYGBIV at full saturation -- the strip renders pure channel
// values cleanly, and washed-out presets were only ever a stand-in.
const QUICK_COLORS: { name: string; rgb: RGB }[] = [
  { name: 'Red', rgb: [255, 0, 0] },
  { name: 'Orange', rgb: [255, 127, 0] },
  { name: 'Yellow', rgb: [255, 255, 0] },
  { name: 'Green', rgb: [0, 255, 0] },
  { name: 'Blue', rgb: [0, 0, 255] },
  { name: 'Indigo', rgb: [75, 0, 130] },
  { name: 'Violet', rgb: [148, 0, 211] },
]

type EffectInspectorProps = {
  event: EditorEvent | null
  /** How many timeline events are selected; >1 swaps in the bulk panel. */
  selectionCount: number
  onClearSelection: () => void
  devices: TimelineDevice[]
  zones: StripZone[]
  pixels: number
  snapMs: number | null
  dirty: boolean
  saving: boolean
  playheadMs: number
  onChange: (patch: Partial<EditorEvent>) => void
  onDuplicate: () => void
  onDelete: () => void
  onSave: () => void
  onCancel: () => void
}

/** Number input that tolerates half-typed values, committing on blur/Enter. */
function DraftNumberField({
  label,
  value,
  suffix,
  min,
  onCommit,
}: {
  label: string
  value: number
  suffix?: string
  min?: number
  onCommit: (next: number) => void
}) {
  const [draft, setDraft] = useState(String(Math.round(value)))
  // Timeline drags change `value` under us; adopt it unless the user is mid-edit.
  const [lastValue, setLastValue] = useState(value)
  if (value !== lastValue) {
    setLastValue(value)
    setDraft(String(Math.round(value)))
  }

  const commit = () => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) {
      setDraft(String(Math.round(value)))
      return
    }
    onCommit(min !== undefined ? Math.max(min, Math.round(parsed)) : Math.round(parsed))
  }

  return (
    <TextField
      size="small"
      label={label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      slotProps={{ input: { endAdornment: suffix ? <Typography variant="caption" sx={{ color: 'text.secondary' }}>{suffix}</Typography> : undefined } }}
      sx={{ flex: 1, '& .MuiOutlinedInput-root': { borderRadius: 2 } }}
    />
  )
}

const HEX_RE = /^([0-9a-f]{3}|[0-9a-f]{6})$/i

/** Typeable hex input. The value can't be driven straight off the event or
 *  every half-typed hex would snap back to the last valid colour. */
function HexField({ value, onChange }: { value: RGB; onChange: (next: RGB) => void }) {
  const hex = rgbToHex(value)
  const [draft, setDraft] = useState(hex)
  // What this field last pushed upward. Comparing against it (rather than the
  // raw prop) means our own edits never rewrite the box mid-type -- typing
  // "#1e9" commits a colour via the 3-digit shorthand, and the next keystroke
  // has to keep extending "#1e9", not the "#11ee99" it expanded to.
  const [pushed, setPushed] = useState(hex)
  if (hex !== pushed) {
    setPushed(hex)
    setDraft(hex)
  }

  const cleaned = draft.trim().replace(/^#/, '')
  const valid = HEX_RE.test(cleaned)

  return (
    <TextField
      size="small"
      value={draft}
      error={!valid}
      spellCheck={false}
      onChange={(e) => {
        const next = e.target.value
        setDraft(next)
        const candidate = next.trim().replace(/^#/, '')
        if (!HEX_RE.test(candidate)) return
        const rgb = hexToRgb(candidate)
        setPushed(rgbToHex(rgb))
        onChange(rgb)
      }}
      onFocus={(e) => e.target.select()}
      onBlur={() => setDraft(valid ? rgbToHex(hexToRgb(cleaned)) : hex)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
      sx={{ width: 116, '& .MuiOutlinedInput-root': { borderRadius: 2 } }}
    />
  )
}

function ColorSwatch({ value, onChange, size = 34 }: { value: RGB; onChange: (next: RGB) => void; size?: number }) {
  return (
    <Box
      component="label"
      sx={{
        width: size,
        height: size,
        borderRadius: 1.5,
        flexShrink: 0,
        cursor: 'pointer',
        background: rgbCss(value),
        border: '1px solid rgba(255,255,255,0.25)',
        display: 'inline-block',
      }}
    >
      <input
        type="color"
        value={rgbToHex(value)}
        onChange={(e) => onChange(hexToRgb(e.target.value))}
        style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }}
      />
    </Box>
  )
}

function SegmentEditor({
  value,
  zones,
  pixels,
  onChange,
}: {
  value: string
  zones: StripZone[]
  pixels: number
  onChange: (next: string) => void
}) {
  const mode = segmentMode(value, zones)
  const [draft, setDraft] = useState(value)
  const [lastValue, setLastValue] = useState(value)
  if (value !== lastValue) {
    setLastValue(value)
    setDraft(value)
  }

  const activeZones = useMemo(() => {
    if (mode !== 'zones') return new Set<string>()
    return new Set(value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))
  }, [mode, value])

  const parsedDraft = parseSegments(draft, zones, pixels)
  const parsedValue = parseSegments(value, zones, pixels)
  const litPixels = parsedValue.ok ? new Set(parsedValue.indices) : new Set<number>()

  const setMode = (next: SegmentMode) => {
    if (next === mode) return
    if (next === 'all') {
      onChange('all')
    } else if (next === 'zones') {
      onChange(zones[0]?.name ?? 'all')
    } else {
      onChange(parsedValue.ok && !parsedValue.all ? indicesToText(parsedValue.indices) : `0-${pixels - 1}`)
    }
  }

  const toggleZone = (zoneName: string) => {
    const next = new Set(activeZones)
    if (next.has(zoneName.toLowerCase())) next.delete(zoneName.toLowerCase())
    else next.add(zoneName.toLowerCase())
    const ordered = zones.filter((z) => next.has(z.name.toLowerCase())).map((z) => z.name)
    onChange(ordered.length ? ordered.join(', ') : 'all')
  }

  return (
    <Stack spacing={1.25}>
      <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, letterSpacing: 0.4 }}>
        SEGMENTS
      </Typography>

      <ToggleButtonGroup
        size="small"
        exclusive
        fullWidth
        value={mode}
        onChange={(_, next) => next && setMode(next as SegmentMode)}
        sx={{ '& .MuiToggleButton-root': { textTransform: 'none', borderRadius: 2, py: 0.5 } }}
      >
        <ToggleButton value="all">All</ToggleButton>
        <ToggleButton value="zones">Segments</ToggleButton>
        <ToggleButton value="custom">Ranges</ToggleButton>
      </ToggleButtonGroup>

      {mode === 'zones' && (
        <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75 }}>
          {zones.map((zone) => {
            const active = activeZones.has(zone.name.toLowerCase())
            return (
              <Chip
                key={zone.name}
                label={`${zone.name} (${zone.start}-${zone.end})`}
                size="small"
                clickable
                onClick={() => toggleZone(zone.name)}
                sx={{
                  borderRadius: 1.5,
                  color: active ? '#ffffff' : 'text.secondary',
                  backgroundColor: active ? alpha('#8ab4ff', 0.24) : alpha('#ffffff', 0.05),
                  border: active ? '1px solid rgba(138,180,255,0.6)' : '1px solid rgba(255,255,255,0.08)',
                }}
              />
            )
          })}
        </Stack>
      )}

      {mode === 'custom' && (
        <TextField
          size="small"
          fullWidth
          value={draft}
          placeholder={`2-7,30-${pixels - 1}`}
          onChange={(e) => {
            setDraft(e.target.value)
            const parsed = parseSegments(e.target.value, zones, pixels)
            if (parsed.ok) onChange(e.target.value.trim())
          }}
          error={!parsedDraft.ok}
          helperText={
            parsedDraft.ok
              ? `${parsedDraft.indices.length} of ${pixels} pixels · indices are 0-${pixels - 1}, zone names allowed`
              : parsedDraft.error
          }
          sx={{ '& .MuiOutlinedInput-root': { borderRadius: 2 } }}
        />
      )}

      <Box
        title={value}
        sx={{ display: 'flex', gap: '2px', height: 14, alignItems: 'stretch' }}
      >
        {Array.from({ length: pixels }, (_, i) => (
          <Box
            key={i}
            sx={{
              flex: 1,
              borderRadius: '2px',
              background: litPixels.has(i) ? '#8ab4ff' : 'rgba(255,255,255,0.08)',
            }}
          />
        ))}
      </Box>
    </Stack>
  )
}

function ParamControl({
  spec,
  event,
  onParamsChange,
}: {
  spec: ParamSpec
  event: EditorEvent
  onParamsChange: (next: Record<string, unknown>) => void
}) {
  const present = Object.prototype.hasOwnProperty.call(event.params, spec.key)
  const fallback = resolveParamDefault(spec, event.color)
  const raw = present ? event.params[spec.key] : fallback

  const setValue = (next: unknown) => onParamsChange({ ...event.params, [spec.key]: next })

  const removeValue = () => {
    const next = { ...event.params }
    delete next[spec.key]
    onParamsChange(next)
  }

  const header = (
    <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {spec.label}
      </Typography>
      {spec.optional ? (
        <Switch
          size="small"
          checked={present}
          onChange={(e) => (e.target.checked ? setValue(fallback) : removeValue())}
        />
      ) : null}
    </Stack>
  )

  if (spec.optional && !present) {
    return (
      <Stack spacing={0.25}>
        {header}
        {spec.help && (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {spec.help}
          </Typography>
        )}
      </Stack>
    )
  }

  if (spec.type === 'bool') {
    return (
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <Stack>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {spec.label}
          </Typography>
          {spec.help && (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {spec.help}
            </Typography>
          )}
        </Stack>
        <Switch size="small" checked={Boolean(raw)} onChange={(e) => setValue(e.target.checked)} />
      </Stack>
    )
  }

  if (spec.type === 'enum') {
    return (
      <Stack spacing={0.5}>
        {header}
        <Select
          size="small"
          fullWidth
          value={String(raw ?? '')}
          onChange={(e) => setValue(e.target.value)}
          sx={{ borderRadius: 2 }}
        >
          {spec.options.map((option) => (
            <MenuItem key={option.value} value={option.value}>
              {option.label}
            </MenuItem>
          ))}
        </Select>
      </Stack>
    )
  }

  if (spec.type === 'color') {
    return (
      <Stack spacing={0.5}>
        {header}
        <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
          <ColorSwatch value={toRgb(raw)} onChange={(next) => setValue(next)} size={28} />
          <HexField value={toRgb(raw)} onChange={(next) => setValue(next)} />
        </Stack>
      </Stack>
    )
  }

  if (spec.type === 'colorList') {
    const list: RGB[] = Array.isArray(raw) ? (raw as unknown[]).map(toRgb) : [toRgb(event.color)]
    return (
      <Stack spacing={0.5}>
        {header}
        <Stack direction="row" sx={{ alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
          {list.map((entry, index) => (
            <Stack key={index} sx={{ alignItems: 'center', gap: 0.25 }}>
              <ColorSwatch
                value={entry}
                size={28}
                onChange={(next) => setValue(list.map((c, i) => (i === index ? next : c)))}
              />
              {list.length > 1 && (
                <Typography
                  variant="caption"
                  onClick={() => setValue(list.filter((_, i) => i !== index))}
                  sx={{ color: 'text.secondary', cursor: 'pointer', ':hover': { color: '#ff6b6b' } }}
                >
                  Remove
                </Typography>
              )}
            </Stack>
          ))}
          <IconButton size="small" onClick={() => setValue([...list, toRgb(event.color)])} aria-label="Add colour">
            <AddRounded fontSize="small" />
          </IconButton>
        </Stack>
      </Stack>
    )
  }

  const numeric = Number(raw ?? 0)
  const value = Number.isFinite(numeric) ? numeric : 0
  return (
    <Stack spacing={0.25}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {spec.label}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
          {value}
          {spec.unit ? ` ${spec.unit}` : ''}
        </Typography>
      </Stack>
      <Slider
        size="small"
        value={Math.min(spec.max, Math.max(spec.min, value))}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        onChange={(_, next) => setValue(spec.type === 'int' ? Math.round(next as number) : (next as number))}
      />
      {spec.help && (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {spec.help}
        </Typography>
      )}
    </Stack>
  )
}

function EffectInspector({
  event,
  selectionCount,
  onClearSelection,
  devices,
  zones,
  pixels,
  snapMs,
  dirty,
  saving,
  playheadMs,
  onChange,
  onDuplicate,
  onDelete,
  onSave,
  onCancel,
}: EffectInspectorProps) {
  const device = event ? devices.find((d) => d.id === event.id) : undefined
  const spec = event ? PATTERN_BY_NAME[event.pattern] : undefined
  const step = snapMs ?? 100

  return (
    <Stack sx={{ height: '100%', minHeight: 0 }}>
      <Stack
        direction="row"
        sx={{
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          px: 2,
          py: 1.25,
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
          <Typography sx={{ fontWeight: 700 }}>Settings</Typography>
          {dirty && (
            <Chip
              label="Unsaved"
              size="small"
              sx={{
                height: 20,
                fontSize: '0.68rem',
                color: '#ffca6b',
                backgroundColor: alpha('#ffca6b', 0.14),
                border: '1px solid rgba(255,202,107,0.3)',
              }}
            />
          )}
        </Stack>
        <Stack direction="row" spacing={1}>
          <Button
            size="small"
            variant="outlined"
            startIcon={<CloseRounded />}
            onClick={onCancel}
            sx={{
              textTransform: 'none',
              borderRadius: 2,
              borderColor: 'rgba(255,255,255,0.16)',
              color: 'text.primary',
              ':hover': { borderColor: 'rgba(255,255,255,0.32)' },
            }}
          >
            Cancel
          </Button>
          <Button
            size="small"
            variant="contained"
            startIcon={<SaveRounded />}
            onClick={onSave}
            disabled={saving || !dirty}
            sx={{ textTransform: 'none', borderRadius: 2, fontWeight: 600 }}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </Stack>
      </Stack>

      <Stack spacing={2} sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 2 }}>
        {selectionCount > 1 ? (
          <Stack spacing={2} sx={{ py: 3, alignItems: 'center', textAlign: 'center' }}>
            <Typography sx={{ fontWeight: 700 }}>{selectionCount} Events Selected</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', maxWidth: 420 }}>
              Drag any one of them to move the whole set, or delete them together. Select a single
              event to edit its settings.
            </Typography>
            <Stack direction="row" spacing={1}>
              <Button
                size="small"
                variant="outlined"
                startIcon={<ContentCopyRounded />}
                onClick={onDuplicate}
                sx={{
                  textTransform: 'none',
                  borderRadius: 2,
                  borderColor: 'rgba(255,255,255,0.14)',
                  color: 'text.primary',
                }}
              >
                Duplicate
              </Button>
              <Button
                size="small"
                variant="outlined"
                startIcon={<DeleteOutlineRounded />}
                onClick={onDelete}
                sx={{
                  textTransform: 'none',
                  borderRadius: 2,
                  borderColor: 'rgba(255,107,107,0.35)',
                  color: '#ff6b6b',
                  ':hover': { borderColor: '#ff6b6b' },
                }}
              >
                Delete {selectionCount}
              </Button>
              <Button size="small" onClick={onClearSelection} sx={{ textTransform: 'none' }}>
                Clear Selection
              </Button>
            </Stack>
          </Stack>
        ) : !event || !device ? (
          <Stack spacing={1} sx={{ py: 4, alignItems: 'center', textAlign: 'center' }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Select an event on the timeline to edit it
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Drag an effect onto a lane to add one, or drag across the lanes to select several
            </Typography>
          </Stack>
        ) : (
          <Box
            sx={{
              display: 'grid',
              // Two columns on a wide screen so the panel doesn't turn into a
              // long scroll while half of it sits empty.
              gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' },
              gap: 2.5,
              alignItems: 'start',
            }}
          >
            <Stack spacing={2}>
            <Stack spacing={1}>
              <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, letterSpacing: 0.4 }}>
                EFFECT
              </Typography>
              <Stack direction="row" spacing={1}>
                <Select
                  size="small"
                  fullWidth
                  value={event.pattern}
                  onChange={(e) => {
                    const pattern = String(e.target.value)
                    onChange({ pattern, params: defaultParams(pattern, event.color) })
                  }}
                  sx={{ borderRadius: 2 }}
                >
                  {PATTERN_SPECS.map((option) => (
                    <MenuItem key={option.name} value={option.name}>
                      {option.label}
                    </MenuItem>
                  ))}
                </Select>
                <Select
                  size="small"
                  fullWidth
                  value={event.id}
                  onChange={(e) => onChange({ id: Number(e.target.value) })}
                  sx={{ borderRadius: 2 }}
                >
                  {devices.map((option) => (
                    <MenuItem key={option.id} value={option.id}>
                      {option.name}
                    </MenuItem>
                  ))}
                </Select>
              </Stack>
              {spec && (
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {spec.description}
                  {device.kind === 'bulb' && !spec.bulbFriendly
                    ? ' · designed for the strip; a bulb only shows its average colour'
                    : ''}
                </Typography>
              )}
            </Stack>

            <Stack spacing={1}>
              <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, letterSpacing: 0.4 }}>
                TIMING
              </Typography>
              <Stack direction="row" spacing={1}>
                <DraftNumberField
                  label="Start"
                  suffix="ms"
                  min={0}
                  value={event.start_ms}
                  onCommit={(next) =>
                    onChange({ start_ms: next, end_ms: Math.max(next + 50, event.end_ms) })
                  }
                />
                <DraftNumberField
                  label="End"
                  suffix="ms"
                  min={0}
                  value={event.end_ms}
                  onCommit={(next) => onChange({ end_ms: Math.max(event.start_ms + 50, next) })}
                />
              </Stack>
              <Stack direction="row" sx={{ alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {formatClock(event.start_ms, true)} → {formatClock(event.end_ms, true)} ·{' '}
                  {((event.end_ms - event.start_ms) / 1000).toFixed(2)}s
                </Typography>
                <Box sx={{ flex: 1 }} />
                <Button
                  size="small"
                  onClick={() => {
                    const start = Math.max(0, Math.round(playheadMs))
                    onChange({ start_ms: start, end_ms: start + (event.end_ms - event.start_ms) })
                  }}
                  sx={{ textTransform: 'none' }}
                >
                  Move to Playhead
                </Button>
                <Button
                  size="small"
                  disabled={!snapMs}
                  onClick={() => {
                    const snap = (ms: number) => Math.round(ms / step) * step
                    const start = Math.max(0, snap(event.start_ms))
                    const end = Math.max(start + step, snap(event.end_ms))
                    onChange({ start_ms: start, end_ms: end })
                  }}
                  sx={{ textTransform: 'none' }}
                >
                  Snap to Grid
                </Button>
              </Stack>
            </Stack>

            {device.kind === 'strip' && (
              <SegmentEditor
                key={event.uid}
                value={event.segments}
                zones={zones}
                pixels={pixels}
                onChange={(next) => onChange({ segments: next })}
              />
            )}
            </Stack>

            <Stack spacing={2}>
            <Stack spacing={1}>
              <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, letterSpacing: 0.4 }}>
                COLOUR
              </Typography>
              <Stack direction="row" sx={{ alignItems: 'center', gap: 1.25 }}>
                <ColorSwatch value={event.color} onChange={(next) => onChange({ color: next })} />
                <HexField value={event.color} onChange={(next) => onChange({ color: next })} />
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  rgb({event.color.join(', ')})
                </Typography>
              </Stack>
              <Stack direction="row" sx={{ gap: 0.75, flexWrap: 'wrap' }}>
                {QUICK_COLORS.map((quick) => (
                  <Box
                    key={quick.name}
                    role="button"
                    aria-label={quick.name}
                    title={`${quick.name} · ${rgbToHex(quick.rgb)}`}
                    onClick={() => onChange({ color: quick.rgb })}
                    sx={{
                      width: 22,
                      height: 22,
                      borderRadius: 1,
                      cursor: 'pointer',
                      background: rgbCss(quick.rgb),
                      border: '1px solid rgba(255,255,255,0.18)',
                    }}
                  />
                ))}
              </Stack>
            </Stack>

            {spec && spec.params.length > 0 && (
              <Stack spacing={1.5}>
                <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, letterSpacing: 0.4 }}>
                  {spec.label.toUpperCase()} SETTINGS
                </Typography>
                {spec.params.map((param) => (
                  <ParamControl
                    key={`${event.uid}:${param.key}`}
                    spec={param}
                    event={event}
                    onParamsChange={(params) => onChange({ params })}
                  />
                ))}
              </Stack>
            )}

            <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />

            <Stack direction="row" spacing={1}>
              <Tooltip title="Duplicate (⌘D)">
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<ContentCopyRounded />}
                  onClick={onDuplicate}
                  sx={{
                    textTransform: 'none',
                    borderRadius: 2,
                    borderColor: 'rgba(255,255,255,0.14)',
                    color: 'text.primary',
                  }}
                >
                  Duplicate
                </Button>
              </Tooltip>
              <Tooltip title="Delete (Del)">
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<DeleteOutlineRounded />}
                  onClick={onDelete}
                  sx={{
                    textTransform: 'none',
                    borderRadius: 2,
                    borderColor: 'rgba(255,107,107,0.35)',
                    color: '#ff6b6b',
                    ':hover': { borderColor: '#ff6b6b' },
                  }}
                >
                  Delete
                </Button>
              </Tooltip>
            </Stack>
            </Stack>
          </Box>
        )}
      </Stack>
    </Stack>
  )
}

export default EffectInspector
