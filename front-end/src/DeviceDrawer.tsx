import { useState } from 'react'
import {
  alpha,
  Box,
  Button,
  Chip,
  Divider,
  Drawer as MuiDrawer,
  IconButton,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import {
  AddRounded,
  CheckRounded,
  CloseRounded,
  DeleteOutlineRounded,
  EditRounded,
  LightRounded,
  LightbulbRounded,
} from '@mui/icons-material'
import type { Bulb } from './App'
import { API_BASE_URL, isStrip } from './config'

type DeviceDrawerProps = {
  open: boolean
  isPhone: boolean
  devices: Bulb[]
  onClose: () => void
  onDevicesChanged: () => void
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** Mirrors the server's check so bad input is caught before the round trip. */
const isValidIp = (value: string) => {
  const match = value.trim().match(IPV4_RE)
  return !!match && match.slice(1).every((part) => Number(part) <= 255)
}

const cardSx = {
  borderRadius: '1.5rem',
  p: 2,
  background: 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02))',
  border: '1px solid rgba(255,255,255,0.06)',
} as const

function DeviceDrawer({ open, isPhone, devices, onClose, onDevicesChanged }: DeviceDrawerProps) {
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftIp, setDraftIp] = useState('')
  const [newName, setNewName] = useState('')
  const [newIp, setNewIp] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const startEdit = (device: Bulb) => {
    setEditingId(device.id ?? null)
    setDraftName(device.name ?? '')
    setDraftIp(device.ip ?? '')
    setError(null)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setError(null)
  }

  /** Nothing here is committed until a request succeeds, so a half-typed
   *  bulb (or a stale error) shouldn't be waiting when the drawer reopens. */
  const handleClose = () => {
    setNewName('')
    setNewIp('')
    setEditingId(null)
    setError(null)
    onClose()
  }

  const request = async (url: string, init: RequestInit) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(url, init)
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error ?? `Request failed (${res.status})`)
        return false
      }
      onDevicesChanged()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  const saveEdit = async (deviceId: number) => {
    if (!isValidIp(draftIp)) {
      setError(`"${draftIp.trim()}" is not a valid IPv4 address`)
      return
    }
    const ok = await request(`${API_BASE_URL}/api/devices/${deviceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: draftName, ip: draftIp.trim() }),
    })
    if (ok) setEditingId(null)
  }

  const addDevice = async () => {
    if (!isValidIp(newIp)) {
      setError(`"${newIp.trim()}" is not a valid IPv4 address`)
      return
    }
    const ok = await request(`${API_BASE_URL}/api/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName, ip: newIp.trim() }),
    })
    if (ok) {
      setNewName('')
      setNewIp('')
    }
  }

  const removeDevice = async (device: Bulb) => {
    const label = device.name || `Bulb ${device.id}`
    if (!window.confirm(`Remove "${label}"? Its timeline events will stay in any saved shows.`)) {
      return
    }
    await request(`${API_BASE_URL}/api/devices/${device.id}`, { method: 'DELETE' })
  }

  return (
    <MuiDrawer
      anchor="right"
      open={open}
      onClose={handleClose}
      slotProps={{
        paper: {
          sx: {
            width: isPhone ? '100vw' : 460,
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
              Devices
            </Typography>
            <Typography sx={{ color: 'text.secondary' }}>Add, rename or remove lights</Typography>
          </Stack>
          <IconButton aria-label="Close devices" onClick={handleClose}>
            <CloseRounded />
          </IconButton>
        </Box>

        <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />

        {error && (
          <Box
            sx={{
              px: 1.5,
              py: 1,
              borderRadius: 2,
              color: '#ff9b9b',
              backgroundColor: alpha('#ff6b6b', 0.12),
              border: '1px solid rgba(255,107,107,0.3)',
            }}
          >
            <Typography variant="body2">{error}</Typography>
          </Box>
        )}

        <Stack spacing={3} sx={{ flex: 1, overflowY: 'auto', pb: 1 }}>
          <Box sx={cardSx}>
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
              <Typography sx={{ fontWeight: 600 }}>Configured</Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {devices.length} device{devices.length === 1 ? '' : 's'}
              </Typography>
            </Stack>

            <Stack spacing={1}>
              {devices.map((device) => {
                const strip = isStrip(device.id)
                const editing = editingId === device.id
                return (
                  <Box
                    key={device.id}
                    sx={{
                      px: 1.25,
                      py: 1,
                      // Same token as the music drawer's track rows, so the
                      // two lists read as the same component.
                      borderRadius: 2,
                      border: editing
                        ? '1px solid rgba(138,180,255,0.5)'
                        : '1px solid rgba(255,255,255,0.06)',
                      background: editing ? alpha('#8ab4ff', 0.08) : 'transparent',
                    }}
                  >
                    {editing ? (
                      // Breathing room top and bottom so the fields aren't
                      // crowded against the row's rounded edge.
                      <Stack spacing={1.25} sx={{ py: 2, px: 1 }}>
                        <TextField
                          size="small"
                          label="Name"
                          fullWidth
                          value={draftName}
                          onChange={(e) => setDraftName(e.target.value)}
                          sx={{ '& .MuiOutlinedInput-root': { borderRadius: 2 } }}
                        />
                        <TextField
                          size="small"
                          label="IP address"
                          fullWidth
                          value={draftIp}
                          onChange={(e) => setDraftIp(e.target.value)}
                          error={draftIp.trim() !== '' && !isValidIp(draftIp)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void saveEdit(device.id ?? 0)
                            if (e.key === 'Escape') cancelEdit()
                          }}
                          sx={{ '& .MuiOutlinedInput-root': { borderRadius: 2 } }}
                        />
                        <Stack direction="row-reverse" spacing={1} sx={{ pt: 0.5 }}>
                          <Button
                            size="small"
                            variant="contained"
                            startIcon={<CheckRounded />}
                            disabled={busy}
                            onClick={() => void saveEdit(device.id ?? 0)}
                            sx={{ textTransform: 'none', borderRadius: 2, fontWeight: 600 }}
                          >
                            Save
                          </Button>
                          <Button
                            size="small"
                            onClick={cancelEdit}
                            sx={{ textTransform: 'none', borderRadius: 2 }}
                          >
                            Cancel
                          </Button>
                        </Stack>
                      </Stack>
                    ) : (
                      <Stack direction="row" sx={{ alignItems: 'center', gap: 1.25 }}>
                        {strip ? (
                          <LightRounded sx={{ color: 'text.secondary' }} />
                        ) : (
                          <LightbulbRounded sx={{ color: 'text.secondary' }} />
                        )}
                        <Stack sx={{ flex: 1, minWidth: 0 }}>
                          <Stack direction="row" sx={{ alignItems: 'center', gap: 0.75 }}>
                            <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
                              {device.name}
                            </Typography>
                            {strip && (
                              <Chip
                                label="Strip"
                                size="small"
                                sx={{
                                  height: 18,
                                  fontSize: '0.65rem',
                                  color: '#8ab4ff',
                                  backgroundColor: alpha('#8ab4ff', 0.14),
                                  border: '1px solid rgba(138,180,255,0.28)',
                                  '& .MuiChip-label': { px: 0.75 },
                                }}
                              />
                            )}
                            {device.online === false && (
                              <Chip
                                label="Offline"
                                size="small"
                                sx={{
                                  height: 18,
                                  fontSize: '0.65rem',
                                  color: '#e0a35c',
                                  backgroundColor: alpha('#e0a35c', 0.14),
                                  border: '1px solid rgba(224,163,92,0.28)',
                                  '& .MuiChip-label': { px: 0.75 },
                                }}
                              />
                            )}
                          </Stack>
                          <Typography variant="caption" sx={{ color: 'text.secondary' }} noWrap>
                            {device.ip} · ID {device.id}
                          </Typography>
                        </Stack>

                        <IconButton
                          size="small"
                          aria-label={`Edit ${device.name}`}
                          onClick={() => startEdit(device)}
                          sx={{ color: 'text.secondary', ':hover': { color: '#8ab4ff' } }}
                        >
                          <EditRounded fontSize="small" />
                        </IconButton>
                        <IconButton
                          size="small"
                          aria-label={`Remove ${device.name}`}
                          disabled={strip}
                          title={
                            strip
                              ? 'The LED strip cannot be removed'
                              : `Remove ${device.name}`
                          }
                          onClick={() => void removeDevice(device)}
                          sx={{
                            color: 'text.secondary',
                            ':hover': { color: '#ff6b6b' },
                            '&.Mui-disabled': { color: 'rgba(255,255,255,0.15)' },
                          }}
                        >
                          <DeleteOutlineRounded fontSize="small" />
                        </IconButton>
                      </Stack>
                    )}
                  </Box>
                )
              })}
            </Stack>
          </Box>

          <Box sx={cardSx}>
            <Typography sx={{ fontWeight: 600, mb: 0.5 }}>Add a bulb</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Needs LAN control enabled in the Govee Home app, and a reserved
              address in your router so it doesn't move.
            </Typography>

            <Stack spacing={1.25} sx={{ mt: 1.5 }}>
              <TextField
                size="small"
                label="Name"
                placeholder="Hallway"
                fullWidth
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                sx={{ '& .MuiOutlinedInput-root': { borderRadius: 2 } }}
              />
              <TextField
                size="small"
                label="IP address"
                placeholder="192.168.2.31"
                fullWidth
                value={newIp}
                onChange={(e) => setNewIp(e.target.value)}
                error={newIp.trim() !== '' && !isValidIp(newIp)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addDevice()
                }}
                sx={{ '& .MuiOutlinedInput-root': { borderRadius: 2 } }}
              />
              <Box>
                <Button
                  variant="outlined"
                  startIcon={<AddRounded />}
                  disabled={busy || !isValidIp(newIp)}
                  onClick={() => void addDevice()}
                  sx={{
                    borderRadius: 3,
                    borderColor: 'rgba(255,255,255,0.14)',
                    color: '#ffffff',
                    textTransform: 'none',
                    fontWeight: 600,
                    ':hover': { borderColor: 'rgba(255,255,255,0.32)' },
                  }}
                >
                  {busy ? 'Working…' : 'Add device'}
                </Button>
              </Box>
            </Stack>
          </Box>
        </Stack>
      </Box>
    </MuiDrawer>
  )
}

export default DeviceDrawer
