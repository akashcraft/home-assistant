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
import devices
from bulb_controller import BulbController, color_to_bulb
from led_patterns import PATTERNS, PatternContext, resolve_segments

# JSON events default to the strip's id; every other configured device is a
# bulb. Both come from bulb_state.json, which the Devices drawer edits.
STRIP_ID = devices.STRIP_DEVICE_ID
BULB_IDS = tuple(devices.bulb_ids())

# --- Strip / network config -------------------------------------------------
IP = devices.strip_ip()
PORT = devices.STRIP_PORT
PIXELS = devices.STRIP_PIXELS
FPS = 30
# The generated onset boxes are consistently late relative to audible output
# on this mixer/device path. Advance the lighting clock by 150 ms.
AUDIO_OUTPUT_LATENCY_MS = -150

# Razer mode times out unless the strip keeps hearing from us, and an all-zero
# frame doesn't appear to count as activity -- which is why gaps in a timeline
# used to end with the strip re-lighting itself in its old govee colour. So we
# send a genuine black frame for gaps and re-assert razer mode on a timer
# instead of relying on the frames alone to hold the connection open.
RAZER_KEEPALIVE_SEC = 2.0

# Floor for "off" pixels. 0 is true black. If gaps ever start reverting to the
# previous colour again, raise this to 1: the frame stays non-zero (and so
# unmistakably live) at a level that is still essentially invisible.
IDLE_LEVEL = 0
IDLE_FRAME = [(IDLE_LEVEL, IDLE_LEVEL, IDLE_LEVEL)] * PIXELS


def is_black(buffer) -> bool:
    return all(r == 0 and g == 0 and b == 0 for r, g, b in buffer)


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
    for e in events:
        e.setdefault("id", STRIP_ID)
    events = sorted(events, key=lambda e: e["start_ms"])
    return events


def split_by_id(events: List[dict]) -> dict:
    """Group events by target device id. id=1 is the LED strip."""
    by_id: dict = {}
    for e in events:
        by_id.setdefault(int(e.get("id", STRIP_ID)), []).append(e)
    return by_id


def find_active_event(events: List[dict], elapsed_ms: float) -> Optional[dict]:
    active = None
    for e in events:
        if e["start_ms"] <= elapsed_ms < e["end_ms"]:
            active = e  # last match wins if events ever overlap
    return active


def find_active_events(events: List[dict], elapsed_ms: float) -> List[dict]:
    """Return all events active at a timestamp, preserving timeline order."""
    return [
        event for event in events
        if event["start_ms"] <= elapsed_ms < event["end_ms"]
    ]


def _render_event(buffer, event, elapsed_ms, audio_analyzer, frame_index):
    segments = resolve_segments(event.get("segments", "all"), len(buffer))
    color = tuple(event.get("color", [255, 255, 255]))
    params = event.get("params", {})
    duration_ms = max(1, event["end_ms"] - event["start_ms"])
    t_ms = elapsed_ms - event["start_ms"]
    progress = max(0.0, min(1.0, t_ms / duration_ms))
    context = PatternContext(
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
    if pattern_fn is None:
        print(f"Warning: unknown pattern '{event['pattern']}'")
        return
    rendered = [(0, 0, 0)] * len(buffer)
    pattern_fn(rendered, context)
    for index, value in enumerate(rendered):
        buffer[index] = tuple(max(buffer[index][channel], value[channel]) for channel in range(3))


def needs_audio_analysis(events: List[dict]) -> bool:
    return any(e.get("pattern") == "audio_spectrum" for e in events)


# --- Main render loop ---------------------------------------------------------

def render_timeline(events: List[dict], audio_analyzer, elapsed_ms_fn, is_running_fn,
                    clock_latency_ms: float = 0):
    """Drive the strip + bulbs from a timeline until is_running_fn() goes False.

    The clock is injected: led_player feeds it pygame's audio position, while
    led_preview.py feeds it a wall clock so the effect editor can sync the
    lights to audio playing in the browser instead. Owns the strip socket and
    the bulb controller, and always blanks + restores on the way out."""
    events_by_id = split_by_id(events)
    strip_events = events_by_id.get(STRIP_ID, [])
    bulb_event_streams = {bid: events_by_id.get(bid, []) for bid in BULB_IDS}
    bulb_active_counts = {bid: len(evs) for bid, evs in bulb_event_streams.items() if evs}
    if bulb_active_counts:
        print(f"Bulb events: {bulb_active_counts}")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.sendto(control(True), (IP, PORT))

    bulb_ctrl = BulbController()
    bulb_ctrl.snapshot()
    bulb_ctrl.start()

    frame_interval = 1.0 / FPS
    frame_index = 0
    next_tick = time.perf_counter()
    next_keepalive = next_tick + RAZER_KEEPALIVE_SEC
    last_event_ids = None
    last_bulb_event_id: dict = {bid: None for bid in BULB_IDS}

    try:
        while is_running_fn():
            elapsed_ms = elapsed_ms_fn() + clock_latency_ms
            if elapsed_ms < 0:
                elapsed_ms = 0

            buffer = [(0, 0, 0)] * PIXELS
            active_events = find_active_events(strip_events, elapsed_ms)
            event_ids = tuple(id(event) for event in active_events)
            if event_ids != last_event_ids:
                last_event_ids = event_ids
                if active_events:
                    print(
                        f"[{elapsed_ms/1000:6.2f}s] "
                        + ", ".join(
                            f"{event['pattern']}[{event.get('layer', 'base')}]"
                            for event in active_events
                        )
                    )
                else:
                    print(f"[{elapsed_ms/1000:6.2f}s] (no active event -- strip off)")

            base_events = [
                event for event in active_events
                if event.get("layer", "base") != "accent"
            ]
            accent_events = [
                event for event in active_events
                if event.get("layer", "base") == "accent"
            ]
            for event in base_events + accent_events:
                _render_event(buffer, event, elapsed_ms, audio_analyzer, frame_index)

            # IDLE_LEVEL 0 sends the buffer untouched; raising it swaps a fully
            # dark frame -- a gap, or an event that paints nothing this tick --
            # for the non-zero floor.
            if IDLE_LEVEL and is_black(buffer):
                buffer = IDLE_FRAME
            sock.sendto(frame(buffer), (IP, PORT))

            now = time.perf_counter()
            if now >= next_keepalive:
                sock.sendto(control(True), (IP, PORT))
                next_keepalive = now + RAZER_KEEPALIVE_SEC

            # Bulbs: treat each as a single-pixel strip and reuse the pattern
            # engine. Only hold/pulse/fade/beats/scramble/rainbow_jump/hold-style
            # patterns translate well; anything else still produces *some* color.
            for bid in BULB_IDS:
                stream = bulb_event_streams[bid]
                if not stream:
                    continue
                bulb_event = find_active_event(stream, elapsed_ms)
                bulb_event_id = id(bulb_event) if bulb_event is not None else None
                if bulb_event_id != last_bulb_event_id[bid]:
                    last_bulb_event_id[bid] = bulb_event_id
                    if bulb_event is not None:
                        print(
                            f"[{elapsed_ms/1000:6.2f}s] bulb {bid} pattern="
                            f"'{bulb_event['pattern']}' color={bulb_event.get('color')}"
                        )
                if bulb_event is None:
                    bulb_ctrl.send(bid, (0, 0, 0), 0)
                    continue
                b_color = tuple(bulb_event.get("color", [255, 255, 255]))
                b_params = bulb_event.get("params", {})
                b_dur = max(1, bulb_event["end_ms"] - bulb_event["start_ms"])
                b_t = elapsed_ms - bulb_event["start_ms"]
                b_progress = max(0.0, min(1.0, b_t / b_dur))
                b_buf = [(0, 0, 0)]
                b_ctx = PatternContext(
                    segments=[0], color=b_color, params=b_params,
                    t_ms=b_t, duration_ms=b_dur, progress=b_progress,
                    now_ms=elapsed_ms, audio=audio_analyzer,
                    frame_index=frame_index,
                )
                pfn = PATTERNS.get(bulb_event["pattern"])
                if pfn is not None:
                    pfn(b_buf, b_ctx)
                rgb_full, brightness_pct = color_to_bulb(b_buf[0])
                bulb_ctrl.send(bid, rgb_full, brightness_pct)

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
        sock.sendto(frame([(0, 0, 0)] * PIXELS), (IP, PORT))
        sock.sendto(control(False), (IP, PORT))
        try:
            bulb_ctrl.stop()
            bulb_ctrl.restore()
        except Exception as e:
            print(f"[bulbs] cleanup error: {e}")


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

    pygame.mixer.init()
    pygame.mixer.music.load(song_path)
    pygame.mixer.music.play()
    print("Playing. Ctrl+C to stop early.")

    try:
        render_timeline(
            events,
            audio_analyzer,
            # ms since play() was called
            elapsed_ms_fn=pygame.mixer.music.get_pos,
            is_running_fn=pygame.mixer.music.get_busy,
            clock_latency_ms=AUDIO_OUTPUT_LATENCY_MS,
        )
    finally:
        pygame.mixer.music.stop()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python led_player.py <song_path> [json_path]")
        sys.exit(1)
    song_arg = sys.argv[1]
    json_arg = sys.argv[2] if len(sys.argv) > 2 else None
    run(song_arg, json_arg)
