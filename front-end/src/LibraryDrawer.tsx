import { useRef, useState } from 'react'
import {
  alpha,
  Box,
  Button,
  Checkbox,
  Divider,
  CircularProgress,
  Drawer as MuiDrawer,
  FormControlLabel,
  IconButton,
  Stack,
  Typography,
} from '@mui/material'
import {
  CloseRounded,
  DataObjectRounded,
  DeleteOutlineRounded,
  MusicNoteRounded,
  PlayArrowRounded,
  StopRounded,
  UploadFileRounded,
} from '@mui/icons-material'
import type { MusicTrack } from './MusicTile'

type LibraryDrawerProps = {
  open: boolean
  isPhone: boolean
  tracks: MusicTrack[]
  playing: string | null
  /** Basename currently loading (spinner in place of the play icon). */
  loadingBasename?: string | null
  /** True when another browser owns playback -- disable play buttons here. */
  disablePlayback?: boolean
  linkToLights: boolean
  onLinkToLightsChange: (next: boolean) => void
  artUrl: (basename: string) => string
  apiBase: string
  onClose: () => void
  onPlay: (basename: string) => void
  onStop: () => void
  onLibraryChanged: () => void
}

function LibraryDrawer({
  open,
  isPhone,
  tracks,
  playing,
  loadingBasename,
  disablePlayback,
  linkToLights,
  onLinkToLightsChange,
  artUrl,
  apiBase,
  onClose,
  onPlay,
  onStop,
  onLibraryChanged,
}: LibraryDrawerProps) {
  const [uploading, setUploading] = useState(false)
  const [pendingName, setPendingName] = useState<string | null>(null)
  const audioInputRef = useRef<HTMLInputElement | null>(null)
  const jsonInputRef = useRef<HTMLInputElement | null>(null)

  const handleAudioPick = () => {
    if (uploading) return
    audioInputRef.current?.click()
  }

  const handleJsonPick = () => {
    if (uploading) return
    jsonInputRef.current?.click()
  }

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // Reset input so re-uploading the same file works.
    event.target.value = ''
    if (!file) return

    setUploading(true)
    setPendingName(file.name)
    try {
      const form = new FormData()
      form.append('audio', file)

      const res = await fetch(`${apiBase}/api/music/upload`, {
        method: 'POST',
        body: form,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        window.alert(`Upload failed: ${body.error ?? res.statusText}`)
        return
      }
      const data = await res.json()
      if (data && data.has_art === false) {
        window.alert(
          `Uploaded "${data.basename ?? file.name}", but no embedded album art was found. The tile will show a placeholder.`,
        )
      }
      onLibraryChanged()
    } catch (err) {
      window.alert(`Upload failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setUploading(false)
      setPendingName(null)
    }
  }

  const handleJsonChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    // The server matches the JSON to a track by name, but catching the
    // mismatch here lets the user confirm before anything is sent.
    const stem = file.name.replace(/\.[^.]+$/, '')
    const match = tracks.find((track) => track.basename === stem)
    if (!match) {
      window.alert(
        `No track named "${stem}" in the library. Name the JSON exactly like its song (e.g. "${tracks[0]?.basename ?? 'song'}.json").`,
      )
      return
    }
    if (match.has_json && !window.confirm(`"${stem}" already has a timeline JSON. Overwrite it?`)) {
      return
    }

    setUploading(true)
    setPendingName(file.name)
    try {
      const form = new FormData()
      form.append('json', file)

      const res = await fetch(`${apiBase}/api/music/upload-json`, {
        method: 'POST',
        body: form,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        window.alert(`JSON upload failed: ${body.error ?? res.statusText}`)
        return
      }
      onLibraryChanged()
    } catch (err) {
      window.alert(`JSON upload failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setUploading(false)
      setPendingName(null)
    }
  }

  const handleDelete = async (basename: string) => {
    if (!window.confirm(`Delete "${basename}"? This removes the audio, album art and timeline JSON.`)) {
      return
    }
    try {
      const res = await fetch(`${apiBase}/api/music/${encodeURIComponent(basename)}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        window.alert(`Delete failed: ${body.error ?? res.statusText}`)
        return
      }
      onLibraryChanged()
    } catch (err) {
      window.alert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const uploadButtonSx = {
    borderRadius: 3,
    borderColor: 'rgba(255,255,255,0.14)',
    color: '#ffffff',
    textTransform: 'none',
    fontWeight: 600,
    ':hover': { borderColor: 'rgba(255,255,255,0.32)' },
  } as const

  const cardSx = {
    borderRadius: '1.5rem',
    p: 2,
    background: 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02))',
    border: '1px solid rgba(255,255,255,0.06)',
  } as const

  return (
    <MuiDrawer
      anchor="right"
      open={open}
      onClose={onClose}
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
              Library
            </Typography>
            <Typography sx={{ color: 'text.secondary' }}>Add, play or delete tracks</Typography>
          </Stack>
          <IconButton aria-label="Close library" onClick={onClose}>
            <CloseRounded />
          </IconButton>
        </Box>

        <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />

        <Stack spacing={3} sx={{ flex: 1, overflowY: 'auto', pb: 1 }}>
          <Box sx={cardSx}>
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
              <Typography sx={{ fontWeight: 600 }}>Add music</Typography>
            </Stack>

            <Stack spacing={1.25}>
              <FormControlLabel
                sx={{
                  m: 0,
                  width: '100%',
                  px: 1,
                  py: 0.25,
                  borderRadius: 2,
                  border: linkToLights
                    ? '1px solid rgba(138,180,255,0.5)'
                    : '1px solid rgba(255,255,255,0.06)',
                  background: linkToLights ? alpha('#8ab4ff', 0.12) : 'transparent',
                }}
                control={
                  <Checkbox
                    size="small"
                    checked={linkToLights}
                    onChange={(e) => onLinkToLightsChange(e.target.checked)}
                    sx={{
                      color: 'rgba(255,255,255,0.35)',
                      '&.Mui-checked': { color: '#8ab4ff' },
                    }}
                  />
                }
                label={
                  <Stack spacing={0.25}>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      Enable Light Show
                    </Typography>
                  </Stack>
                }
              />
            </Stack>

            <Box sx={{ mt: 2, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
              <Button
                variant="outlined"
                startIcon={<UploadFileRounded />}
                onClick={handleAudioPick}
                disabled={uploading}
                sx={uploadButtonSx}
              >
                {uploading ? 'Uploading…' : 'Upload Music'}
              </Button>
              <Button
                variant="outlined"
                startIcon={<DataObjectRounded />}
                onClick={handleJsonPick}
                disabled={uploading}
                sx={uploadButtonSx}
              >
                Upload JSON
              </Button>
              {pendingName ? (
                <Typography variant="caption" sx={{ color: 'text.secondary' }} noWrap>
                  {pendingName}
                </Typography>
              ) : null}
            </Box>

            <input
              ref={audioInputRef}
              type="file"
              accept=".mp3,.wav,.m4a,.flac,.ogg,audio/*"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
            <input
              ref={jsonInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleJsonChange}
              style={{ display: 'none' }}
            />
          </Box>

          <Box sx={cardSx}>
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
              <Typography sx={{ fontWeight: 600 }}>Tracks</Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {tracks.length} in library
              </Typography>
            </Stack>

            {tracks.length === 0 ? (
              <Typography variant="body2" sx={{ color: 'text.secondary', py: 2, textAlign: 'center' }}>
                No tracks yet
              </Typography>
            ) : (
              <Stack spacing={0.75}>
                {tracks.map((track) => {
                  const isPlaying = playing === track.basename
                  return (
                    <Stack
                      key={track.basename}
                      direction="row"
                      sx={{
                        alignItems: 'center',
                        gap: 1.25,
                        px: 1,
                        py: 0.75,
                        borderRadius: 2,
                        border: isPlaying
                          ? '1px solid rgba(138,180,255,0.5)'
                          : '1px solid rgba(255,255,255,0.06)',
                        background: isPlaying ? alpha('#8ab4ff', 0.1) : 'transparent',
                      }}
                    >
                      <Box
                        sx={{
                          width: 40,
                          height: 40,
                          borderRadius: 1.5,
                          overflow: 'hidden',
                          flexShrink: 0,
                          display: 'grid',
                          placeItems: 'center',
                          background: track.has_art
                            ? `url(${artUrl(track.basename)}) center / cover no-repeat`
                            : alpha('#ffffff', 0.06),
                          border: '1px solid rgba(255,255,255,0.08)',
                        }}
                      >
                        {!track.has_art && <MusicNoteRounded fontSize="small" sx={{ color: 'text.secondary' }} />}
                      </Box>

                      <Stack sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
                          {track.basename}
                        </Typography>
                        {!track.has_json && (
                          <Typography variant="caption" sx={{ color: 'text.secondary' }} noWrap>
                            No JSON Uploaded
                          </Typography>
                        )}
                      </Stack>

                      {(() => {
                        const isLoading = loadingBasename === track.basename
                        return (
                          <IconButton
                            size="small"
                            aria-label={isPlaying ? 'Stop' : 'Play'}
                            disabled={isLoading || (!isPlaying && !!disablePlayback)}
                            onClick={() => (isPlaying ? onStop() : onPlay(track.basename))}
                            sx={{
                              color: '#ffffff',
                              backgroundColor: alpha('#ffffff', 0.08),
                              ':hover': { backgroundColor: alpha('#ffffff', 0.16) },
                              '&.Mui-disabled': { color: 'rgba(255,255,255,0.3)' },
                            }}
                          >
                            {isLoading ? (
                              <CircularProgress size={16} thickness={5} sx={{ color: '#ffffff' }} />
                            ) : isPlaying ? (
                              <StopRounded fontSize="small" />
                            ) : (
                              <PlayArrowRounded fontSize="small" />
                            )}
                          </IconButton>
                        )
                      })()}

                      <IconButton
                        size="small"
                        aria-label="Delete track"
                        onClick={() => handleDelete(track.basename)}
                        sx={{
                          color: 'text.secondary',
                          ':hover': { color: '#ff6b6b' },
                        }}
                      >
                        <DeleteOutlineRounded fontSize="small" />
                      </IconButton>
                    </Stack>
                  )
                })}
              </Stack>
            )}
          </Box>
        </Stack>
      </Box>
    </MuiDrawer>
  )
}

export default LibraryDrawer
