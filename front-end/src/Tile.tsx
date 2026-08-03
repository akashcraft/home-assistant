import { alpha, Box, Card, Chip, Stack, Typography } from '@mui/material'
import { LightbulbRounded, LightbulbOutlineRounded, LightRounded, SettingsRounded } from '@mui/icons-material'
import type { Bulb } from './App'
import { presetColors } from './Drawer'

type TileProps = {
  bulb?: Bulb
  onToggle: (bulbId: number) => void
  onOpenSettings: (bulbId: number) => void
  isPhone?: boolean
}

function Tile({ bulb, onToggle, onOpenSettings, isPhone }: TileProps) {
  if (!bulb) {
    return null
  }

  const isOffline = bulb.online === false
  const accent = !isOffline && bulb.on ? bulb.color : '#6b7280'

  return (
    <Card
      elevation={0}
      sx={{
        position: 'relative',
        width: '100%',
        maxWidth: isPhone ? '100%' : '14.25rem',
        overflow: 'hidden',
        borderRadius: 1,
        border: !isOffline && bulb.on ? `1px solid ${alpha(bulb.color ?? '#6b7280', 0.35)}` : '1px solid rgba(255,255,255,0.06)',
        background: !isOffline && bulb.on
          ? `linear-gradient(180deg, ${alpha(bulb.color ?? '#6b7280', 0.22)} 0%, rgba(14, 16, 24, 0.94) 32%, rgba(9, 10, 15, 0.98) 100%)`
          : 'linear-gradient(180deg, rgba(30, 34, 42, 0.95) 0%, rgba(12, 14, 18, 0.98) 100%)',
        opacity: isOffline ? 0.55 : 1,
        transition: 'transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease, opacity 140ms ease',
        pointerEvents: isOffline ? 'none' : 'auto',
        ":hover": {
          cursor: isOffline ? 'not-allowed' : 'pointer',
        },
      }}
      onClick={() => {
        if (isOffline) return
        onToggle(bulb?.id ?? 0)
      }}
    >
      <Box
        sx={{
          width: '100%',
          height: '100%',
          p: '1rem',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2 }}>
          {bulb.id === 1 ?
            <LightRounded
              sx={{
                fontSize: 33,
                color: accent,
                filter: bulb.on ? 'drop-shadow(0 10px 22px rgba(0,0,0,0.3))' : 'none',
              }}
            /> : bulb.on ? (<LightbulbRounded
              sx={{
                fontSize: 33,
                color: accent,
                filter: bulb.on ? 'drop-shadow(0 10px 22px rgba(0,0,0,0.3))' : 'none',
              }}
            />) : (<
              LightbulbOutlineRounded
              sx={{
                fontSize: 33,
                color: accent,
                filter: bulb.on ? 'drop-shadow(0 10px 22px rgba(0,0,0,0.3))' : 'none',
              }}
            />)}

          <Chip
            size="small"
            label={isOffline ? 'Offline' : bulb.on ? 'On' : 'Off'}
            sx={{
              backgroundColor: bulb.on && !isOffline ? alpha(bulb.color ?? '#6b7280', 0.18) : alpha('#ffffff', 0.06),
              color: bulb.on && !isOffline ? '#ffffff' : 'text.secondary',
              border: bulb.on && !isOffline ? `1px solid ${alpha(bulb.color ?? '#6b7280', 0.28)}` : '1px solid rgba(255,255,255,0.06)',
            }}
          />
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', margin: "1.5rem 0.25rem" }}>
          <Stack spacing={0.5}>
            <Typography variant="h6" sx={{ color: bulb.on ? 'text.primary' : 'text.secondary', fontWeight: 700 }}>
              {bulb.name}
            </Typography>
            <Typography sx={{ color: 'text.secondary' }}>{presetColors.find((c) => c.color === bulb.color)?.name || "Custom"}</Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {isOffline ? 'Offline' : `Brightness ${bulb.brightness}%`}
            </Typography>
          </Stack>
        </Box>

        <Stack
          onClick={(event) => {
            event.stopPropagation()
            onOpenSettings(bulb?.id ?? 0)
          }}
          sx={{
            width: 48,
            height: 48,
            alignItems: 'center',
            justifyContent: 'center',
            position: 'absolute',
            bottom: "1rem",
            right: "1rem",
            zIndex: 1,
            borderRadius: '1rem',
            backgroundColor: alpha('#ffffff', 0.06),
            border: '1px solid rgba(255,255,255,0.08)',
            ":hover": {
              cursor: 'pointer',
            },
          }}
        >
          <SettingsRounded sx={{ color: bulb.on ? '#ffffff' : 'text.secondary' }} />
        </Stack>
      </Box>
    </Card>
  )
}

export default Tile