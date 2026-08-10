import { useMemo, useState } from 'react'
import { alpha, Box, Chip, InputAdornment, Stack, TextField, Typography } from '@mui/material'
import { DragIndicatorRounded, SearchRounded } from '@mui/icons-material'
import { PATTERN_SPECS, type PatternSpec } from './effectSchema'

type EffectPaletteProps = {
  /** Pointer-down on a palette row starts a drag onto a timeline lane. */
  onDragStart: (pattern: string, clientX: number, clientY: number) => void
  /** Tap-to-arm fallback: armed effect drops on the next lane tap. */
  armedPattern: string | null
  onArm: (pattern: string | null) => void
  draggingPattern: string | null
}

function EffectPalette({ onDragStart, armedPattern, onArm, draggingPattern }: EffectPaletteProps) {
  const [query, setQuery] = useState('')

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return PATTERN_SPECS
    return PATTERN_SPECS.filter(
      (spec: PatternSpec) =>
        spec.label.toLowerCase().includes(needle) ||
        spec.name.includes(needle) ||
        spec.description.toLowerCase().includes(needle),
    )
  }, [query])

  return (
    <Stack sx={{ height: '100%', minHeight: 0 }}>
      <Stack
        direction="row"
        sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1, px: 2, pt: 1.75, pb: 1.25 }}
      >
        <Typography sx={{ fontWeight: 700 }}>Effects</Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          Drag onto a Lane
        </Typography>
      </Stack>

      <Box sx={{ px: 2, pb: 1.25 }}>
        <TextField
          size="small"
          fullWidth
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter Effects"
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchRounded fontSize="small" sx={{ color: 'text.secondary' }} />
                </InputAdornment>
              ),
            },
          }}
          sx={{ '& .MuiOutlinedInput-root': { borderRadius: 2 } }}
        />
      </Box>

      <Stack spacing={0.75} sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 2, pb: 2 }}>
        {visible.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary', py: 2, textAlign: 'center' }}>
            No effects match "{query}"
          </Typography>
        ) : (
          visible.map((spec) => {
            const armed = armedPattern === spec.name
            const dragging = draggingPattern === spec.name
            return (
              <Box
                key={spec.name}
                role="button"
                tabIndex={0}
                title={spec.description}
                onPointerDown={(e) => {
                  if (e.button !== 0 && e.pointerType === 'mouse') return
                  onDragStart(spec.name, e.clientX, e.clientY)
                }}
                onClick={() => onArm(armed ? null : spec.name)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onArm(armed ? null : spec.name)
                  }
                }}
                sx={{
                  px: 1.25,
                  py: 1,
                  borderRadius: 2,
                  cursor: 'grab',
                  touchAction: 'none',
                  userSelect: 'none',
                  opacity: dragging ? 0.45 : 1,
                  border: armed ? '1px solid rgba(138,180,255,0.6)' : '1px solid rgba(255,255,255,0.06)',
                  background: armed ? alpha('#8ab4ff', 0.12) : 'rgba(255,255,255,0.02)',
                  transition: 'border-color 120ms ease, background 120ms ease',
                  ':hover': { borderColor: 'rgba(255,255,255,0.22)' },
                }}
              >
                <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                  <DragIndicatorRounded fontSize="small" sx={{ color: 'rgba(255,255,255,0.28)' }} />
                  <Stack sx={{ flex: 1, minWidth: 0 }}>
                    <Stack direction="row" sx={{ alignItems: 'center', gap: 0.75 }}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
                        {spec.label}
                      </Typography>
                      {spec.bulbFriendly && (
                        <Chip
                          label="Bulb"
                          size="small"
                          sx={{
                            height: 17,
                            fontSize: '0.62rem',
                            color: '#8ab4ff',
                            backgroundColor: alpha('#8ab4ff', 0.14),
                            border: '1px solid rgba(138,180,255,0.28)',
                            '& .MuiChip-label': { px: 0.75 },
                          }}
                        />
                      )}
                    </Stack>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }} noWrap>
                      {spec.description}
                    </Typography>
                  </Stack>
                </Stack>
              </Box>
            )
          })
        )}
      </Stack>
    </Stack>
  )
}

export default EffectPalette
