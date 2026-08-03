import { alpha, Box, Card, Stack, Typography } from '@mui/material'
import {
  MusicNoteRounded,
  PlayArrowRounded,
  StopRounded,
} from '@mui/icons-material'

export type MusicTrack = {
  basename: string
  filename: string
  has_art: boolean
  has_json: boolean
}

type MusicTileProps = {
  track: MusicTrack
  isPlaying: boolean
  /** Someone else's browser owns playback -- lock this tile out. */
  disabled?: boolean
  isPhone?: boolean
  artUrl: (basename: string) => string
  onPlay: (basename: string) => void
  onStop: () => void
}

function MusicTile({
  track,
  isPlaying,
  disabled,
  isPhone,
  artUrl,
  onPlay,
  onStop,
}: MusicTileProps) {
  const artSrc = track.has_art ? artUrl(track.basename) : null
  const locked = !!disabled && !isPlaying

  return (
    <Card
      elevation={0}
      sx={{
        position: 'relative',
        width: '100%',
        maxWidth: isPhone ? '100%' : '14.25rem',
        overflow: 'hidden',
        borderRadius: 1,
        border: isPlaying
          ? '1px solid rgba(255,255,255,0.35)'
          : '1px solid rgba(255,255,255,0.06)',
        background: 'linear-gradient(180deg, rgba(30,34,42,0.95) 0%, rgba(12,14,18,0.98) 100%)',
        transition: 'transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease, opacity 140ms ease',
        opacity: locked ? 0.5 : 1,
        pointerEvents: locked ? 'none' : 'auto',

        ':hover': {
          cursor: locked ? 'not-allowed' : 'pointer',
        },

        ...(artSrc && {
          '&::before': {
            content: '""',
            position: 'absolute',
            inset: 0,
            backgroundImage: `url(${artSrc})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            zIndex: 0,
          },

          '&::after': {
            content: '""',
            position: 'absolute',
            inset: 0,
            background: `
          linear-gradient(
            to bottom,
            rgba(9,10,15,0.12) 0%,
            rgba(9,10,15,0.18) 55%,
            rgba(9,10,15,0.70) 78%,
            rgba(9,10,15,0.95) 92%,
            rgb(9,10,15) 100%
          )
        `,
            zIndex: 1,
          },
        }),
      }}
      onClick={() => (isPlaying ? onStop() : onPlay(track.basename))}
    >
      <Box
        sx={{
          position: 'relative',
          zIndex: 2,
          width: '100%',
          height: '100%',
          p: '1rem',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          minHeight: '11.5rem',
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 2,
          }}
        >
          <MusicNoteRounded
            sx={{
              fontSize: 33,
              color: isPlaying ? '#ffffff' : 'text.secondary',
              filter: isPlaying
                ? 'drop-shadow(0 10px 22px rgba(0,0,0,0.3))'
                : 'none',
            }}
          />
        </Box>

        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            margin: '1.5rem 0.25rem',
          }}
        >
          <Typography
            variant="h6"
            sx={{ color: 'text.primary', fontWeight: 700 }}
          >
            {track.basename}
          </Typography>
        </Box>

        <Stack
          onClick={(event) => {
            event.stopPropagation()
            if (isPlaying) {
              onStop()
            } else {
              onPlay(track.basename)
            }
          }}
          sx={{
            width: 48,
            height: 48,
            alignItems: 'center',
            justifyContent: 'center',
            position: 'absolute',
            bottom: '1rem',
            right: '1rem',
            zIndex: 3,
            borderRadius: '1rem',
            backgroundColor: alpha('#ffffff', 0.12),
            border: '1px solid rgba(255,255,255,0.14)',
            ':hover': {
              cursor: 'pointer',
            },
          }}
        >
          {isPlaying ? (
            <StopRounded sx={{ color: '#ffffff' }} />
          ) : (
            <PlayArrowRounded sx={{ color: '#ffffff' }} />
          )}
        </Stack>
      </Box>
    </Card>
  )
}

export default MusicTile
