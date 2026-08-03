import { alpha, Box, Card, Chip, Stack, Typography } from '@mui/material'
import { BedtimeOutlined, BedtimeRounded, LightRounded, PlayArrowRounded, StopRounded, WbSunnyOutlined, WbSunnyRounded } from '@mui/icons-material'
import type { RoutineData } from './RoutineData'
import type { Bulb } from './App'

type RoutineTileProps = {
  routine: RoutineData
  bulbs: Bulb[]
  onPower: (bulbId: number, powerState: boolean) => void
  onColorChange: (bulbId?: number, color?: string) => void
  onBrightnessChange: (bulbId?: number, brightness?: number) => void
  isPhone: boolean
}

function RoutineTile({ routine, bulbs, onPower, onColorChange, onBrightnessChange, isPhone }: RoutineTileProps) {
  if (!routine) {
    return null
  }

  let accent;
  if (routine.isGlobalOff == undefined) {
    const colors: string[] = []
    routine.actions?.forEach((action) => {
      if (action.actionType === 'color' && action.value) {
        colors.push(action.value as string)
      }
    })
    let averageColor;
    if (colors.length > 0) {
      averageColor = colors.reduce((acc, color) => {
        const r = parseInt(color.slice(1, 3), 16)
        const g = parseInt(color.slice(3, 5), 16)
        const b = parseInt(color.slice(5, 7), 16)
        return [acc[0] + r, acc[1] + g, acc[2] + b]
      }, [0, 0, 0])
      accent = `#${((1 << 24) + (averageColor[0] / colors.length << 16) + (averageColor[1] / colors.length << 8) + (averageColor[2] / colors.length)).toString(16).slice(1)}`
    } else {
      accent = '#fff'
    }
  } else {
    accent = '#fff'
  }

  let routineActive = true;
  if (routine.isGlobalOff == undefined) {
    for (const action of routine.actions ?? []) {
      const targetBulb = bulbs.find((bulb) => bulb.id === action.bulbId)
      if (targetBulb?.on) {
        if (action.actionType === 'color' && action.value) {
          if (targetBulb.color !== action.value) {
            routineActive = false;
            break;
          }
        } else if (action.actionType === 'brightness' && action.value) {
          if (targetBulb.brightness !== action.value) {
            routineActive = false;
            break;
          }
        }
      } else {
        routineActive = false;
        break;
      }
    }
  } else if (routine.isGlobalOff === true) {
    for (const bulb of bulbs) {
      if (bulb.on) {
        routineActive = false;
        break;
      }
    }
  } else if (routine.isGlobalOff === false) {
    for (const bulb of bulbs) {
      if (!bulb.on || bulb.color !== '#ffffff' || bulb.brightness !== 100) {
        routineActive = false;
        break;
      }
    }
  }

  const handleRoutineClick = () => {
    if (routine.isGlobalOff == undefined) {
      const usedBulbIds: number[] = []
      if (!routineActive) {
        for (const action of routine.actions ?? []) {
          if (!usedBulbIds.includes(action.bulbId)) {
            onPower(action.bulbId, true)
          }
          usedBulbIds.push(action.bulbId)
          if (action.actionType === 'color' && action.value) {
            onColorChange(action.bulbId, action.value as string)
          } else if (action.actionType === 'brightness' && action.value) {
            onBrightnessChange(action.bulbId, action.value as number)
          }
        }
      } else {
        for (const action of routine.actions ?? []) {
          if (!usedBulbIds.includes(action.bulbId)) {
            onPower(action.bulbId, false)
          }
          usedBulbIds.push(action.bulbId)
        }
      }
    } else if (routine.isGlobalOff) {
      for (const bulb of bulbs) {
        if (bulb.on) {
          onPower(bulb.id ?? 0, false)
        }
      }
    } else if (routine.isGlobalOff === false) {
      if (routineActive) {
        for (const bulb of bulbs) {
          onPower(bulb.id ?? 0, false)
        }
      } else {
        for (const bulb of bulbs) {
          onColorChange(bulb.id, '#ffffff')
          onBrightnessChange(bulb.id, 100)
          onPower(bulb.id ?? 0, true)
        }
      }
    }
  }
  return (
    <Card
      elevation={0}
      sx={{
        position: 'relative',
        width: '100%',
        maxWidth: isPhone ? '100%' : '14.25rem',
        overflow: 'hidden',
        borderRadius: 1,
        border: routineActive ? `1px solid ${alpha(accent ?? '#6b7280', 0.35)}` : '1px solid rgba(255,255,255,0.06)',
        background: routineActive
          ? `linear-gradient(180deg, ${alpha(accent ?? '#6b7280', 0.22)} 0%, rgba(14, 16, 24, 0.94) 32%, rgba(9, 10, 15, 0.98) 100%)`
          : 'linear-gradient(180deg, rgba(30, 34, 42, 0.95) 0%, rgba(12, 14, 18, 0.98) 100%)',
        transition: 'transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease',
        ":hover": {
          cursor: 'pointer',
        },
      }}
      onClick={handleRoutineClick}
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
          {routine.isGlobalOff == undefined ?
            <LightRounded
              sx={{
                fontSize: 33,
                color: routineActive ? accent : 'text.secondary',
                filter: routineActive ? 'drop-shadow(0 10px 22px rgba(0,0,0,0.3))' : 'none',
              }}
            /> : routine.isGlobalOff === true ? routineActive ? (
              <BedtimeRounded
                sx={{
                  fontSize: 33,
                  color: routineActive ? accent : 'text.secondary',
                  filter: routineActive ? 'drop-shadow(0 10px 22px rgba(0,0,0,0.3))' : 'none',
                }}
              />) : (
              <BedtimeOutlined
                sx={{
                  fontSize: 33,
                  color: routineActive ? accent : 'text.secondary',
                  filter: routineActive ? 'drop-shadow(0 10px 22px rgba(0,0,0,0.3))' : 'none',
                }}
              />
            ) :
              routineActive ? (
                <WbSunnyRounded
                  sx={{
                    fontSize: 33,
                    color: routineActive ? accent : 'text.secondary',
                    filter: routineActive ? 'drop-shadow(0 10px 22px rgba(0,0,0,0.3))' : 'none',
                  }}
                />) : (<WbSunnyOutlined
                  sx={{
                    fontSize: 33,
                    color: routineActive ? accent : 'text.secondary',
                    filter: routineActive ? 'drop-shadow(0 10px 22px rgba(0,0,0,0.3))' : 'none',
                  }}
                />)}

          <Chip
            size="small"
            label={routineActive ? 'Active' : 'Off'}
            sx={{
              backgroundColor: routineActive && routineActive ? alpha(accent, 0.18) : alpha('#ffffff', 0.06),
              color: routineActive && routineActive ? '#ffffff' : 'text.secondary',
              border: routineActive && routineActive ? `1px solid ${alpha(accent, 0.28)}` : '1px solid rgba(255,255,255,0.06)',
            }}
          />
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', margin: "1.5rem 0.25rem" }}>
          <Stack spacing={0.5}>
            <Typography variant="h6" sx={{ color: routineActive ? 'text.primary' : 'text.secondary', fontWeight: 700 }}>
              {routine.name}
            </Typography>
          </Stack>
        </Box>

        <Stack
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
          {routineActive ? <StopRounded sx={{ color: routineActive ? '#ffffff' : 'text.secondary' }} /> : <PlayArrowRounded sx={{ color: routineActive ? '#ffffff' : 'text.secondary' }} />}
        </Stack>
      </Box>
    </Card>
  )
}

export default RoutineTile