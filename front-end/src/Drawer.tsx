import {
  alpha,
  Box,
  ButtonBase,
  Divider,
  Drawer as MuiDrawer,
  IconButton,
  Slider,
  Stack,
  Typography,
} from '@mui/material'
import { CloseRounded } from '@mui/icons-material'
import type { Bulb } from './App'

type DrawerProps = {
  open: boolean
  isPhone: boolean
  bulb?: Bulb
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

function LightSettingsDrawer({
  open,
  isPhone,
  bulb,
  onClose,
  onBrightnessChange,
  onColorChange,
}: DrawerProps) {
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
                  onChange={(event) => onColorChange(bulb?.id, event.target.value)}
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    opacity: 0,
                    cursor: 'pointer',
                  }}
                />
              </Box>
            </Box>

            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                gap: 1.5,
              }}
            >
              {presetColors.map((preset) => {
                const isSelected = preset.color.toLowerCase() === bulb?.color?.toLowerCase()

                return (
                  <ButtonBase
                    key={preset.name}
                    onClick={() => onColorChange(bulb?.id, preset.color)}
                    sx={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 0.8,
                      p: 0.5,
                      borderRadius: 3,
                    }}
                  >
                    <Box
                      sx={{
                        width: 38,
                        height: 38,
                        borderRadius: '50%',
                        backgroundColor: preset.color,
                        border: isSelected ? '2px solid #ffffff' : '2px solid rgba(255,255,255,0.16)',
                        boxShadow: isSelected ? `0 0 0 5px ${alpha(preset.color, 0.22)}` : 'none',
                      }}
                    />
                  </ButtonBase>
                )
              })}
            </Box>
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
        </Stack>
      </Box>
    </MuiDrawer>
  )
}

export default LightSettingsDrawer