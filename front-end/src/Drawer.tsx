import { useState } from 'react'
import {
  alpha,
  Box,
  Checkbox,
  Divider,
  Drawer as MuiDrawer,
  FormControlLabel,
  IconButton,
  Slider,
  Stack,
  Typography,
} from '@mui/material'
import { CloseRounded } from '@mui/icons-material'
import { API_BASE_URL, type Bulb } from './App'

type DrawerProps = {
  open: boolean
  isPhone: boolean
  bulb?: Bulb
  stripActive?: string[]
  onClose: () => void
  onBrightnessChange: (bulbId?: number, brightness?: number) => void
  onColorChange: (bulbId?: number, color?: string) => void
}

// eslint-disable-next-line react-refresh/only-export-components
export const presetColors = [
  { name: 'Red', color: '#ff0000' },
  { name: 'Orange', color: '#ff680a' },
  { name: 'Yellow', color: '#ffd60a' },
  { name: 'Green', color: '#30d158' },
  { name: 'Blue', color: '#0a84ff' },
  { name: 'Indigo', color: '#5e5ce6' },
  { name: 'Violet', color: '#bf5af2' },
  { name: 'White', color: '#ffffff' },
]

const MAIN_LIGHT_ID = 1
// Keep this list in sync with engine/led_patterns.py ZONES + server.py STRIP_ZONES.
const STRIP_SEGMENTS = ['All', 'Table', 'Bed', 'Kitchen', 'Main', 'Final'] as const
type StripSegment = (typeof STRIP_SEGMENTS)[number]

async function postStripSegments(segments: StripSegment[], color: string) {
  try {
    await fetch(`${API_BASE_URL}/api/bulbs/${MAIN_LIGHT_ID}/segments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segments, color, exclusive: true }),
    })
  } catch {
    // UI stays responsive even if the server is unreachable.
  }
}

async function postMainLightPower(on: boolean) {
  try {
    await fetch(`${API_BASE_URL}/api/bulbs/${MAIN_LIGHT_ID}/power`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    })
  } catch {
    // UI stays responsive even if the server is unreachable.
  }
}

const INDIVIDUAL_SEGMENTS: StripSegment[] = STRIP_SEGMENTS.filter((s) => s !== 'All')

function deriveSelected(active?: string[]): StripSegment[] {
  if (!active || active.length === 0) return []
  const valid = active
    .map((name) => INDIVIDUAL_SEGMENTS.find((s) => s.toLowerCase() === name.toLowerCase()))
    .filter((s): s is StripSegment => s !== undefined)
  if (INDIVIDUAL_SEGMENTS.every((s) => valid.includes(s))) return ['All']
  return valid
}

function LightSettingsDrawer({
  open,
  isPhone,
  bulb,
  stripActive,
  onClose,
  onBrightnessChange,
  onColorChange,
}: DrawerProps) {
  const isMainLight = bulb?.id === MAIN_LIGHT_ID
  const [selectedSegments, setSelectedSegments] = useState<StripSegment[]>(() =>
    deriveSelected(stripActive),
  )
  const [lastPushKey, setLastPushKey] = useState<string>('')

  const openKey = open && isMainLight ? String(bulb?.id ?? '') : ''
  const [lastOpenKey, setLastOpenKey] = useState<string>(openKey)
  if (openKey !== lastOpenKey) {
    setLastOpenKey(openKey)
    if (openKey !== '') {
      setSelectedSegments(deriveSelected(stripActive))
      setLastPushKey('')
    }
  }

  // Sync from server broadcasts (other clients, engine, etc.) while the drawer
  // is open, using the "adjust state during render" pattern.
  const serverKey = isMainLight ? (stripActive ?? []).slice().sort().join(',') : ''
  const [lastServerKey, setLastServerKey] = useState<string>(serverKey)
  if (open && isMainLight && serverKey !== lastServerKey) {
    setLastServerKey(serverKey)
    setSelectedSegments(deriveSelected(stripActive))
  }

  const applySegmentChange = (nextSegments: StripSegment[], color?: string) => {
    if (!isMainLight || !color) {
      return
    }
    const key = `${nextSegments.slice().sort().join(',')}|${color.toLowerCase()}`
    if (key === lastPushKey) {
      return
    }
    setLastPushKey(key)
    // Empty selection = every zone off. Backend handles this via exclusive mode.
    void postStripSegments(nextSegments, color)
  }

  const toggleSegment = (segment: StripSegment) => {
    setSelectedSegments((current) => {
      let next: StripSegment[]
      if (segment === 'All') {
        next = current.includes('All') ? [] : ['All']
      } else {
        const withoutAll = current.filter((s) => s !== 'All')
        next = withoutAll.includes(segment)
          ? withoutAll.filter((s) => s !== segment)
          : [...withoutAll, segment]
        // Collapse to "All" once every individual zone is picked.
        if (INDIVIDUAL_SEGMENTS.every((s) => next.includes(s))) {
          next = ['All']
        }
      }
      if (next.length === 0) {
        // Deselecting everything is a power-off intent for the strip.
        setLastPushKey('')
        void postMainLightPower(false)
      } else if (bulb?.color) {
        applySegmentChange(next, bulb.color)
      }
      return next
    })
  }

  const handleColorSelect = (color: string) => {
    if (isMainLight && selectedSegments.length > 0) {
      // Drawer routes per-zone via the segments endpoint. We skip the /color
      // endpoint here so a partial selection like ["Kitchen"] isn't clobbered
      // by an implicit "all zones" color update.
      applySegmentChange(selectedSegments, color)
      return
    }
    onColorChange(bulb?.id, color)
  }

  return (
    <MuiDrawer
      anchor="right"
      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: {
            width: isPhone ? '100vw' : 420,
            maxWidth: '100vw',
            background: 'rgba(9, 11, 17, 0.98)',
            backdropFilter: 'blur(24px)',
            borderLeft: '1px solid rgba(255,255,255,0.08)',
          },
        },
      }}
    >
      <Box sx={{ p: 2.5, height: '100%', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2 }}>
          <Stack spacing={0.5}>
            <Typography variant="h5" sx={{ fontWeight: 700 }}>
              Settings
            </Typography>
            <Typography sx={{ color: 'text.secondary' }}>{bulb?.name}</Typography>
          </Stack>

          <IconButton aria-label="Close light settings" onClick={onClose}>
            <CloseRounded />
          </IconButton>
        </Box>

        <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />

        <Stack spacing={3} sx={{ flex: 1, overflowY: 'auto', pb: 1 }}>
          <Box
            sx={{
              borderRadius: '1.5rem',
              p: 2,
              background: 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02))',
              border: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Typography sx={{ fontWeight: 600 }}>Colour</Typography>
              </Stack>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {bulb?.color?.toUpperCase()}
              </Typography>
            </Stack>

            <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
              <Box
                component="label"
                sx={{
                  width: 108,
                  height: 108,
                  display: 'grid',
                  placeItems: 'center',
                  cursor: 'pointer',
                  position: 'relative',
                  borderRadius: '50%',
                  background: `${bulb?.color}`,
                  border: '1px solid rgba(255,255,255,0.1)',
                }}
              >
                <Box
                  component="input"
                  type="color"
                  value={bulb?.color}
                  onChange={(event) => handleColorSelect(event.target.value)}
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    opacity: 0,
                    cursor: 'pointer',
                  }}
                />
              </Box>
            </Box>
            <Typography variant="h6" sx={{ color: 'text.secondary', textAlign: 'center' }}>
              {presetColors.find((c) => c.color === bulb?.color)?.name ?? "Custom"}
            </Typography>
            <Stack
              direction="row"
              sx={{
                flexWrap: 'wrap',
                marginTop: "1.5rem",
                gap: 1.5,
                width: '100%',
                padding: '0 1rem',
              }}
            >
              {presetColors.map((preset) => {
                const isSelected = preset.color.toLowerCase() === bulb?.color?.toLowerCase()

                return (
                  <Box
                    key={preset.name}
                    onClick={() => handleColorSelect(preset.color)}
                    sx={{
                      width: "3.5rem",
                      height: "3.5rem",
                      borderRadius: '50%',
                      cursor: 'pointer',
                      margin: "0.412rem",
                      backgroundColor: preset.color,
                      border: isSelected ? '2px solid #ffffff' : '2px solid rgba(255,255,255,0.16)',
                      boxShadow: isSelected ? `0 0 0 5px ${alpha(preset.color, 0.22)}` : 'none',
                    }}
                  />
                )
              })}
            </Stack>
          </Box>

          <Box
            sx={{
              borderRadius: '1.5rem',
              p: 2,
              background: 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02))',
              border: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
              <Typography sx={{ fontWeight: 600 }}>Brightness</Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {bulb?.brightness}%
              </Typography>
            </Stack>
            <Slider
              value={bulb?.brightness}
              min={1}
              max={100}
              step={1}
              sx={{
                color: bulb?.color ?? '#6b7280',
                '& .MuiSlider-thumb': {
                  width: 20,
                  height: 20,
                  backgroundColor: '#ffffff',
                  border: '2px solid currentColor',
                },
              }}
              onChange={(_, value) => {
                if (typeof value === 'number') {
                  onBrightnessChange(bulb?.id, value)
                }
              }}
            />
          </Box>


          {isMainLight && (
            <Box
              sx={{
                borderRadius: '1.5rem',
                p: 2,
                background: 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02))',
                border: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                <Typography sx={{ fontWeight: 600 }}>Segments</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {selectedSegments.length === 0
                    ? 'None'
                    : selectedSegments.includes('All')
                      ? 'All'
                      : `${selectedSegments.length} selected`}
                </Typography>
              </Stack>

              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                  columnGap: 1,
                  rowGap: 0.25,
                }}
              >
                {STRIP_SEGMENTS.map((segment) => {
                  const checked = selectedSegments.includes(segment)
                  const accent = bulb?.color ?? '#8ab4ff'
                  return (
                    <FormControlLabel
                      key={segment}
                      sx={{
                        m: 0,
                        px: 1,
                        py: 0.25,
                        borderRadius: 2,
                        border: checked
                          ? `1px solid ${alpha(accent, 0.5)}`
                          : '1px solid rgba(255,255,255,0.06)',
                        background: checked
                          ? alpha(accent, 0.12)
                          : 'transparent',
                        transition: 'background 140ms ease, border-color 140ms ease',
                      }}
                      control={
                        <Checkbox
                          size="small"
                          checked={checked}
                          onChange={() => toggleSegment(segment)}
                          sx={{
                            color: 'rgba(255,255,255,0.35)',
                            '&.Mui-checked': { color: accent },
                          }}
                        />
                      }
                      label={
                        <Typography variant="body2" sx={{ fontWeight: 500 }}>
                          {segment}
                        </Typography>
                      }
                    />
                  )
                })}
              </Box>
            </Box>
          )}
        </Stack>
      </Box>
    </MuiDrawer>
  )
}

export default LightSettingsDrawer
