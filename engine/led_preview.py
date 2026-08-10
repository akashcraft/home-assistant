"""
Renders a timeline against a wall clock, with no audio of its own.

This is what the effect editor's "Sync Lights" toggle drives: the browser
plays the song locally and the room follows along, so unsaved edits can be
watched on the real hardware before they're written to the track's JSON.

Prints a single "READY" line once setup is done (loading the waveform for
audio_spectrum events can take a few seconds) -- the caller waits for that
line before starting its own playback, so the two clocks line up.

Usage:
    python led_preview.py timeline.json [--start-ms 12000] [--song track.mp3]

Stop it with SIGINT; the strip is blanked and the bulbs restored on the way
out, exactly as led_player.py does.
"""

from __future__ import annotations

import argparse
import time

from audio_analyzer import AudioAnalyzer
from led_player import load_timeline, needs_audio_analysis, render_timeline


def run(json_path: str, start_ms: float = 0.0, song_path: str | None = None) -> None:
    events = load_timeline(json_path)
    end_ms = max((e["end_ms"] for e in events), default=0)
    print(f"Loaded {len(events)} events from {json_path}, preview from {start_ms:.0f}ms")

    audio_analyzer = None
    if song_path and needs_audio_analysis(events):
        print("Loading waveform for audio_spectrum analysis...")
        audio_analyzer = AudioAnalyzer(song_path)

    if start_ms >= end_ms:
        print(f"Nothing to preview past {start_ms:.0f}ms (timeline ends at {end_ms}ms)")
        print("READY", flush=True)
        return

    # Everything slow is done; the caller starts its audio when it sees this.
    print("READY", flush=True)

    started = time.perf_counter()

    def elapsed_ms() -> float:
        return start_ms + (time.perf_counter() - started) * 1000.0

    render_timeline(
        events,
        audio_analyzer,
        elapsed_ms_fn=elapsed_ms,
        is_running_fn=lambda: elapsed_ms() < end_ms,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Preview an LED timeline without playing audio.")
    parser.add_argument("json_path")
    parser.add_argument("--start-ms", type=float, default=0.0,
                        help="Position in the timeline to start rendering from.")
    parser.add_argument("--song", default=None,
                        help="Audio file, only needed when the timeline uses audio_spectrum.")
    args = parser.parse_args()
    run(args.json_path, args.start_ms, args.song)
