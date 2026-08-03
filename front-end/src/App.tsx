import { useEffect, useState } from 'react'
import './App.css'
import {
  alpha,
  Box,
  Chip,
  CssBaseline,
  Stack,
  Typography,
} from '@mui/material'
import { useMediaQuery } from '@mui/material'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { io, Socket } from 'socket.io-client'
import BulbDrawer from './Drawer'
import Tile from './Tile'
import { routineData } from './RoutineData'
import RoutineTile from './RoutineTile'

export type Bulb = {
  id?: number
  name?: string
  ip?: string
  on?: boolean
  brightness?: number
  color?: string
}

type BulbSnapshot = {
  id: number
  name: string
  ip: string
  on: boolean
  brightness: number
  color: string
}

const API_BASE_URL = 'http://192.168.2.27:8080'

const darkTheme = createTheme({
  palette: {
    mode: 'dark',
    background: {
      default: '#06070b',
      paper: '#0d1018',
    },
    primary: {
      main: '#8ab4ff',
    },
    text: {
      primary: '#f7f8fb',
      secondary: '#a8b0bf',
    },
  },
  typography: {
    fontFamily:
      '"SF Pro Display", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  shape: {
    borderRadius: 20,
  },
})

function App() {
  const isPhone = useMediaQuery(darkTheme.breakpoints.down('sm'))
  const [bulbs, setBulbs] = useState<Bulb[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [selectedBulbId, setSelectedBulbId] = useState<number>(0)
  const [currentDateTime, setCurrentDateTime] = useState(() => new Date())

  const selectedBulb = bulbs.find((bulb) => bulb.id === selectedBulbId) ?? bulbs[0]
  const activeBulbs = bulbs.filter((bulb) => bulb.on).length

  useEffect(() => {
    const updateClock = () => setCurrentDateTime(new Date())

    updateClock()
    const intervalId = window.setInterval(updateClock, 1000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [])

  useEffect(() => {
    const socket: Socket = io(API_BASE_URL, {
      autoConnect: false,
      transports: ['websocket'],
    })

    const applyBulbsState = (incoming: BulbSnapshot[]) => {
      if (!Array.isArray(incoming)) {
        return
      }

      setBulbs(incoming.map((bulb) => ({ ...bulb })))
    }

    const applyBulbUpdate = (incoming: BulbSnapshot) => {
      if (!incoming || typeof incoming.id !== 'number') {
        return
      }

      setBulbs((current) => current.map((bulb) => (bulb.id === incoming.id ? { ...bulb, ...incoming } : bulb)))
    }

    socket.on('bulbs_state', applyBulbsState)
    socket.on('bulb_updated', applyBulbUpdate)
    socket.connect()

    return () => {
      socket.off('bulbs_state', applyBulbsState)
      socket.off('bulb_updated', applyBulbUpdate)
      socket.disconnect()
    }
  }, [])

  const updateBulb = (bulbId: number, updater: (bulb: Bulb) => Bulb) => {
    setBulbs((current) => current.map((bulb) => (bulb.id === bulbId ? updater(bulb) : bulb)))
  }

  const postBulbCommand = async (bulbId: number, endpoint: string, body: Record<string, unknown>) => {
    try {
      await fetch(`${API_BASE_URL}/api/bulbs/${bulbId}/${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    } catch {
      // The UI stays responsive even if UDP transport or the server is unavailable.
    }
  }

  const handlePower = (bulbId: number, powerState: boolean) => {
    const bulb = bulbs.find((item) => item.id === bulbId)

    if (!bulb) {
      return
    }

    void postBulbCommand(bulbId, 'power', { on: powerState })
  }

  const handleToggle = (bulbId: number) => {
    const bulb = bulbs.find((item) => item.id === bulbId)

    if (!bulb) {
      return
    }

    void postBulbCommand(bulbId, 'toggle', {})
  }

  const handleBrightnessChange = (bulbId?: number, brightness?: number) => {
    if (bulbId === undefined || brightness === undefined) {
      return
    }
    updateBulb(bulbId, (item) => ({ ...item, brightness }))
    void postBulbCommand(bulbId, 'brightness', { brightness })
  }

  const handleColorChange = (bulbId?: number, color?: string) => {
    if (bulbId === undefined || color === undefined) {
      return
    }
    updateBulb(bulbId, (item) => ({ ...item, color }))
    void postBulbCommand(bulbId, 'color', { color })
  }

  const currentDate = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(currentDateTime)

  const currentTime = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(currentDateTime)

  return (
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
      <Box
        sx={{
          px: { xs: 2, sm: 3, md: 4 },
          py: { xs: 2, sm: 3, md: 4 },
        }}
      >
        <Stack spacing={3} sx={{ width: '100%', maxWidth: 1240, mx: 'auto' }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'space-between',
              gap: 2,
              flexWrap: 'wrap',
            }}
          >
            <Typography variant="h4" sx={{ fontWeight: 700, lineHeight: 1.05 }}>
              Routines
            </Typography>

            <Stack direction="row" spacing={1.5}>
              <Typography sx={{ fontWeight: 700 }}>{currentDate}</Typography>
              <Typography sx={{ color: 'text.secondary', width: "3.75rem" }}>{currentTime}</Typography>
            </Stack>
          </Box>

          <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 2 }}>
            {routineData.map((routine) => (
              <RoutineTile
                key={routine.id}
                bulbs={bulbs}
                routine={routine}
                onPower={handlePower}
                isPhone={isPhone}
                onColorChange={handleColorChange}
                onBrightnessChange={handleBrightnessChange}
              />
            ))}
          </Stack>
        </Stack>
      </Box >
      <Box
        sx={{
          px: { xs: 2, sm: 3, md: 4 },
          py: { xs: 2, sm: 3, md: 4 },
        }}
      >
        <Stack spacing={3} sx={{ width: '100%', maxWidth: 1240, mx: 'auto' }}>
          <Stack
            direction="row"
            sx={{
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 2,
              flexWrap: 'wrap',
            }}
          >
            <Stack spacing={1}>
              <Typography variant="h4" sx={{ fontWeight: 700, lineHeight: 1.05 }}>
                Devices
              </Typography>
            </Stack>

            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <Chip
                label={`${activeBulbs} active`}
                sx={{
                  backgroundColor: alpha('#ffffff', 0.06),
                  color: 'text.primary',
                  border: '1px solid rgba(255,255,255,0.08)',
                }}
              />
            </Stack>
          </Stack>

          <Box sx={{ margin: "0.2rem !important" }} />

          <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 2 }}>
            {bulbs.map((bulb) => (
              <Tile
                key={bulb.id}
                bulb={bulb}
                onToggle={handleToggle}
                isPhone={isPhone}
                onOpenSettings={(bulbId) => {
                  setSelectedBulbId(bulbId)
                  setDrawerOpen(true)
                }}
              />
            ))}
          </Stack>
        </Stack>
        <BulbDrawer
          open={drawerOpen}
          isPhone={isPhone}
          bulb={selectedBulb}
          onClose={() => setDrawerOpen(false)}
          onColorChange={handleColorChange}
          onBrightnessChange={handleBrightnessChange}
        />
      </Box >
    </ThemeProvider >
  )
}

export default App
