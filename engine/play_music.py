"""Minimal pygame.mixer runner used as a subprocess by server.py so that
music-only playback (no LED sync) can be started and SIGTERM'd cleanly.

Usage:
    python play_music.py <song_path>
"""

from __future__ import annotations

import sys
import time

import pygame


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: play_music.py <song_path>")
        return 1
    song = sys.argv[1]
    pygame.mixer.init()
    pygame.mixer.music.load(song)
    pygame.mixer.music.play()
    try:
        while pygame.mixer.music.get_busy():
            time.sleep(0.15)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            pygame.mixer.music.stop()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
