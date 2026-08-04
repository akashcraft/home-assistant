import { useEffect, useRef, useState } from 'react'
import './App.css'
import {
  alpha,
  Box,
  Chip,
  CssBaseline,
  Stack,
  Typography,
} from '@mui/material'
import { LibraryMusicOutlined } from '@mui/icons-material'
import { useMediaQuery } from '@mui/material'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { io, Socket } from 'socket.io-client'
import BulbDrawer from './Drawer'
import Tile from './Tile'
import { routineData } from './RoutineData'
import RoutineTile from './RoutineTile'
import MusicTile, { type MusicTrack } from './MusicTile'
import LibraryDrawer from './LibraryDrawer'

export type Bulb = {
  id?: number
  name?: string
  ip?: string
  on?: boolean
  brightness?: number
  color?: string
  online?: boolean
}

type BulbSnapshot = {
  id: number
  name: string
  ip: string
  on: boolean
  brightness: number
  color: string
  online?: boolean
}

export const API_BASE_URL = 'http://192.168.1.1:8080'

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

type StripState = {
  zones: string[]
  colors: Record<string, string>
  active: string[]
  on: boolean
}

type MusicState = {
  playing: string | null
  linked: boolean
  owner: string | null
}

// Stable-per-browser id so the server can enforce single-owner playback.
const CLIENT_ID = (() => {
  const key = 'client.id'
  const existing = localStorage.getItem(key)
  if (existing) return existing
  const fresh = (crypto.randomUUID?.() ?? `c-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  localStorage.setItem(key, fresh)
  return fresh
})()

const artUrl = (basename: string) =>
  `${API_BASE_URL}/api/music/${encodeURIComponent(basename)}/art`

function App() {
  const isPhone = useMediaQuery(darkTheme.breakpoints.down('sm'))
  const [bulbs, setBulbs] = useState<Bulb[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [selectedBulbId, setSelectedBulbId] = useState<number>(0)
  const [currentDateTime, setCurrentDateTime] = useState(() => new Date())
  const [stripState, setStripState] = useState<StripState>({
    zones: [], colors: {}, active: [], on: false,
  })
  const [musicTracks, setMusicTracks] = useState<MusicTrack[]>([])
  const [musicState, setMusicState] = useState<MusicState>({ playing: null, linked: false, owner: null })
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [linkToLights, setLinkToLights] = useState<boolean>(() => {
    return localStorage.getItem('library.linkToLights') === 'true'
  })
  useEffect(() => {
    localStorage.setItem('library.linkToLights', linkToLights ? 'true' : 'false')
  }, [linkToLights])
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const isOwner = musicState.owner === CLIENT_ID
  const isBusyElsewhere = musicState.playing !== null && !isOwner

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

    const applyStripUpdate = (incoming: StripState) => {
      if (!incoming || !Array.isArray(incoming.active)) {
        return
      }
      setStripState({
        zones: incoming.zones ?? [],
        colors: incoming.colors ?? {},
        active: incoming.active,
        on: !!incoming.on,
      })
    }

    const applyMusicLibrary = (incoming: MusicTrack[]) => {
      if (!Array.isArray(incoming)) return
      setMusicTracks(incoming)
    }

    const applyMusicState = (incoming: MusicState) => {
      if (!incoming) return
      setMusicState({
        playing: incoming.playing ?? null,
        linked: !!incoming.linked,
        owner: incoming.owner ?? null,
      })
      // Server said nobody is playing (natural end, stop, or someone else
      // took over) -- silence the local <audio> if it was ours.
      if (!incoming.playing && audioRef.current) {
        audioRef.current.pause()
        audioRef.current.removeAttribute('src')
        audioRef.current.load()
      }
    }

    socket.on('bulbs_state', applyBulbsState)
    socket.on('bulb_updated', applyBulbUpdate)
    socket.on('strip_updated', applyStripUpdate)
    socket.on('music_library_updated', applyMusicLibrary)
    socket.on('music_updated', applyMusicState)
    socket.connect()

    return () => {
      socket.off('bulbs_state', applyBulbsState)
      socket.off('bulb_updated', applyBulbUpdate)
      socket.off('strip_updated', applyStripUpdate)
      socket.off('music_library_updated', applyMusicLibrary)
      socket.off('music_updated', applyMusicState)
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

  const isBulbOffline = (bulbId: number) =>
    bulbs.find((item) => item.id === bulbId)?.online === false

  const handlePower = (bulbId: number, powerState: boolean) => {
    const bulb = bulbs.find((item) => item.id === bulbId)

    if (!bulb || bulb.online === false) {
      return
    }

    void postBulbCommand(bulbId, 'power', { on: powerState })
  }

  const handleToggle = (bulbId: number) => {
    const bulb = bulbs.find((item) => item.id === bulbId)

    if (!bulb || bulb.online === false) {
      return
    }

    void postBulbCommand(bulbId, 'toggle', {})
  }

  const handleBrightnessChange = (bulbId?: number, brightness?: number) => {
    if (bulbId === undefined || brightness === undefined) {
      return
    }
    if (isBulbOffline(bulbId)) {
      return
    }
    updateBulb(bulbId, (item) => ({ ...item, brightness }))
    void postBulbCommand(bulbId, 'brightness', { brightness })
  }

  const handleColorChange = (bulbId?: number, color?: string) => {
    if (bulbId === undefined || color === undefined) {
      return
    }
    if (isBulbOffline(bulbId)) {
      return
    }
    updateBulb(bulbId, (item) => ({ ...item, color }))
    void postBulbCommand(bulbId, 'color', { color })
  }

  const refreshMusicLibrary = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/music`)
      if (!res.ok) return
      const data = await res.json()
      if (Array.isArray(data)) setMusicTracks(data)
    } catch {
      // Ignore transient network errors; socket will resync later.
    }
  }

  const handleMusicPlay = async (basename: string) => {
    if (isBusyElsewhere) {
      window.alert('Music is already playing on another device.')
      return
    }
    try {
      const res = await fetch(`${API_BASE_URL}/api/music/${encodeURIComponent(basename)}/play`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ link_to_lights: linkToLights, owner: CLIENT_ID }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        window.alert(`Playback failed: ${body.error ?? res.statusText}`)
        return
      }
      const data = await res.json().catch(() => ({}))
      // We're the owner now -- kick off the local <audio> so this browser is
      // the only one making sound.
      const el = audioRef.current
      if (el && data.stream_url) {
        el.src = `${API_BASE_URL}${data.stream_url}`
        el.load()
        void el.play().catch(() => {
          // Autoplay blocked? Unlikely since we're inside a user gesture,
          // but nothing to do if it is.
        })
      }
    } catch (err) {
      window.alert(`Playback failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleMusicStop = async () => {
    // Optimistic local pause so the button feels responsive.
    if (audioRef.current) audioRef.current.pause()
    try {
      await fetch(`${API_BASE_URL}/api/music/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner: CLIENT_ID }),
      })
    } catch {
      // Best-effort; the socket will echo the real state.
    }
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
          stripActive={stripState.active}
          onClose={() => setDrawerOpen(false)}
          onColorChange={handleColorChange}
          onBrightnessChange={handleBrightnessChange}
        />
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
                Music
              </Typography>
            </Stack>

            <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <Chip
                clickable
                onClick={() => setLibraryOpen(true)}
                icon={<LibraryMusicOutlined fontSize="small" />}
                label={`${musicTracks.length} track${musicTracks.length === 1 ? '' : 's'}`}
                sx={{
                  backgroundColor: alpha('#ffffff', 0.06),
                  color: 'text.primary',
                  border: '1px solid rgba(255,255,255,0.08)',
                  height: 38,
                  borderRadius: "1.5rem",
                  padding: "0 0.25rem",
                  alignItems: 'center',
                }}
              />
            </Stack>
          </Stack>

          <Box sx={{ margin: "0.2rem !important" }} />

          <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 2 }}>
            {musicTracks.length === 0 ? (
              <Box
                onClick={() => setLibraryOpen(true)}
                sx={{
                  width: '100%',
                  maxWidth: isPhone ? '100%' : '14.25rem',
                  minHeight: '11.5rem',
                  borderRadius: 1,
                  border: '1px dashed rgba(255,255,255,0.14)',
                  display: 'grid',
                  placeItems: 'center',
                  cursor: 'pointer',
                  color: 'text.secondary',
                  transition: 'border-color 140ms ease, color 140ms ease',
                  ':hover': { borderColor: 'rgba(255,255,255,0.3)', color: 'text.primary' },
                }}
              >
                <Stack spacing={0.5} sx={{ alignItems: 'center' }}>
                  <Typography sx={{ fontWeight: 600 }}>No tracks</Typography>
                  <Typography variant="caption">Tap to open the library</Typography>
                </Stack>
              </Box>
            ) : musicTracks.map((track) => (
              <MusicTile
                key={track.basename}
                track={track}
                isPlaying={musicState.playing === track.basename}
                disabled={isBusyElsewhere}
                isPhone={isPhone}
                artUrl={artUrl}
                onPlay={handleMusicPlay}
                onStop={handleMusicStop}
              />
            ))}
          </Stack>
        </Stack>

        <LibraryDrawer
          open={libraryOpen}
          isPhone={isPhone}
          tracks={musicTracks}
          playing={musicState.playing}
          disablePlayback={isBusyElsewhere}
          linkToLights={linkToLights}
          onLinkToLightsChange={setLinkToLights}
          artUrl={artUrl}
          apiBase={API_BASE_URL}
          onClose={() => setLibraryOpen(false)}
          onPlay={handleMusicPlay}
          onStop={handleMusicStop}
          onLibraryChanged={() => void refreshMusicLibrary()}
        />
        {/* Global HTML5 audio -- controlled entirely by 'music_play' /
            'music_updated' socket events so every connected browser plays
            the same song in near-sync. */}
        <audio
          ref={audioRef}
          preload="auto"
          onEnded={() => { void handleMusicStop() }}
        />
      </Box >
    </ThemeProvider >
  )
}

export default App
