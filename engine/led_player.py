"""
Loads <song>.mp3/.wav from disk plus a matching <song>.json timeline,
plays the song with pygame.mixer, and drives the 45-segment LED strip
in sync using the pattern engine in led_patterns.py.

Usage:
    python led_player.py songs/my_track.mp3

Expects a JSON file at the same path with .json instead of the audio
extension (e.g. songs/my_track.json). See example_song.json for the format.
"""

from __future__ import annotations

import base64
import json
import os
import socket
import sys
import time
from typing import List, Optional

import pygame

from audio_analyzer import AudioAnalyzer
from led_patterns import PATTERNS, PatternContext, resolve_segments

# --- Strip / network config -------------------------------------------------
IP = "192.168.2.30"
PORT = 4003
PIXELS = 45
FPS = 30


def checksum(packet: List[int]) -> int:
    value = 0
    for byte in packet:
        value ^= byte
    return value


def frame(colors) -> bytes:
    packet = [0xBB, 0x00, 0xFA, 0xB0, 0x00, len(colors)]
    for r, g, b in colors:
        packet.extend([r, g, b])
    packet.append(checksum(packet))
    payload = base64.b64encode(bytes(packet)).decode("ascii")
    return json.dumps({"msg": {"cmd": "razer", "data": {"pt": payload}}}).encode()


def control(enabled: bool) -> bytes:
    packet = [0xBB, 0x00, 0x01, 0xB1, 0x01 if enabled else 0x00, 0x0A if enabled else 0x0B]
    payload = base64.b64encode(bytes(packet)).decode("ascii")
    return json.dumps({"msg": {"cmd": "razer", "data": {"pt": payload}}}).encode()


# --- Timeline loading --------------------------------------------------------

def load_timeline(json_path: str) -> List[dict]:
    with open(json_path, "r") as f:
        data = json.load(f)
    events = data["events"] if isinstance(data, dict) and "events" in data else data
    events = sorted(events, key=lambda e: e["start_ms"])
    return events


def find_active_event(events: List[dict], elapsed_ms: float) -> Optional[dict]:
    active = None
    for e in events:
        if e["start_ms"] <= elapsed_ms < e["end_ms"]:
            active = e  # last match wins if events ever overlap
    return active


def needs_audio_analysis(events: List[dict]) -> bool:
    return any(e.get("pattern") == "audio_spectrum" for e in events)


# --- Main render loop ---------------------------------------------------------

def run(song_path: str, json_path: Optional[str] = None):
    if json_path is None:
        base, _ = os.path.splitext(song_path)
        json_path = base + ".json"

    events = load_timeline(json_path)
    print(f"Loaded {len(events)} events from {json_path}")

    audio_analyzer = None
    if needs_audio_analysis(events):
        print("Loading waveform for audio_spectrum analysis...")
        audio_analyzer = AudioAnalyzer(song_path)

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.sendto(control(True), (IP, PORT))

    pygame.mixer.init()
    pygame.mixer.music.load(song_path)

    frame_interval = 1.0 / FPS
    frame_index = 0
    next_tick = time.perf_counter()
    last_event_id = None

    pygame.mixer.music.play()
    print("Playing. Ctrl+C to stop early.")

    try:
        while pygame.mixer.music.get_busy():
            elapsed_ms = pygame.mixer.music.get_pos()  # ms since play() was called
            if elapsed_ms < 0:
                elapsed_ms = 0

            buffer = [(0, 0, 0)] * PIXELS
            event = find_active_event(events, elapsed_ms)

            event_id = id(event) if event is not None else None
            if event_id != last_event_id:
                last_event_id = event_id
                if event is not None:
                    segs_preview = event.get("segments", "all")
                    print(
                        f"[{elapsed_ms/1000:6.2f}s] pattern='{event['pattern']}' "
                        f"segments={segs_preview} color={event.get('color')}"
                    )
                else:
                    print(f"[{elapsed_ms/1000:6.2f}s] (no active event -- strip off)")

            if event is not None:
                segments = resolve_segments(event.get("segments", "all"), PIXELS)
                color = tuple(event.get("color", [255, 255, 255]))
                params = event.get("params", {})
                duration_ms = max(1, event["end_ms"] - event["start_ms"])
                t_ms = elapsed_ms - event["start_ms"]
                progress = max(0.0, min(1.0, t_ms / duration_ms))

                ctx = PatternContext(
                    segments=segments,
                    color=color,
                    params=params,
                    t_ms=t_ms,
                    duration_ms=duration_ms,
                    progress=progress,
                    now_ms=elapsed_ms,
                    audio=audio_analyzer,
                    frame_index=frame_index,
                )

                pattern_fn = PATTERNS.get(event["pattern"])
                if pattern_fn is not None:
                    pattern_fn(buffer, ctx)
                else:
                    print(f"Warning: unknown pattern '{event['pattern']}'")

            sock.sendto(frame(buffer), (IP, PORT))
            frame_index += 1

            next_tick += frame_interval
            sleep_time = next_tick - time.perf_counter()
            if sleep_time > 0:
                time.sleep(sleep_time)
            else:
                next_tick = time.perf_counter()  # we fell behind; resync

    except KeyboardInterrupt:
        print("Stopped by user.")
    finally:
        pygame.mixer.music.stop()
        sock.sendto(frame([(0, 0, 0)] * PIXELS), (IP, PORT))
        sock.sendto(control(False), (IP, PORT))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python led_player.py <song_path> [json_path]")
        sys.exit(1)
    song_arg = sys.argv[1]
    json_arg = sys.argv[2] if len(sys.argv) > 2 else None
    run(song_arg, json_arg)
