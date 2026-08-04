"""
Same LED / bulb rendering as led_player.py but *without* pygame audio -- the
audio plays in the user's browser via HTML5 <audio>, and this process just
drives the hardware in sync using a wall-clock reference.

Usage:
    python led_renderer.py <song_path> [json_path]

The song_path is still required because AudioAnalyzer (audio_spectrum
patterns) reads the waveform. The mp3 itself is never played here.
"""

from __future__ import annotations

import base64
import json
import os
import socket
import sys
import time
from typing import List, Optional

from audio_analyzer import AudioAnalyzer
from bulb_controller import BulbController, color_to_bulb
from led_patterns import PATTERNS, PatternContext, resolve_segments
from strip_config import STRIP_IP as IP, STRIP_PORT as PORT, STRIP_PIXELS as PIXELS, STRIP_FPS as FPS

STRIP_ID = 1
BULB_IDS = (2, 3, 4, 5)


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


def load_timeline(json_path: str) -> List[dict]:
    with open(json_path, "r") as f:
        data = json.load(f)
    events = data["events"] if isinstance(data, dict) and "events" in data else data
    for e in events:
        e.setdefault("id", STRIP_ID)
    events = sorted(events, key=lambda e: e["start_ms"])
    return events


def split_by_id(events: List[dict]) -> dict:
    by_id: dict = {}
    for e in events:
        by_id.setdefault(int(e.get("id", STRIP_ID)), []).append(e)
    return by_id


def find_active_event(events: List[dict], elapsed_ms: float) -> Optional[dict]:
    active = None
    for e in events:
        if e["start_ms"] <= elapsed_ms < e["end_ms"]:
            active = e
    return active


def needs_audio_analysis(events: List[dict]) -> bool:
    return any(e.get("pattern") == "audio_spectrum" for e in events)


def run(song_path: str, json_path: Optional[str] = None):
    if json_path is None:
        base, _ = os.path.splitext(song_path)
        json_path = base + ".json"

    events = load_timeline(json_path)
    print(f"Loaded {len(events)} events from {json_path}")
    events_by_id = split_by_id(events)
    strip_events = events_by_id.get(STRIP_ID, [])
    bulb_event_streams = {bid: events_by_id.get(bid, []) for bid in BULB_IDS}

    audio_analyzer = None
    if needs_audio_analysis(events):
        print("Loading waveform for audio_spectrum analysis...")
        audio_analyzer = AudioAnalyzer(song_path)

    total_ms = max((e["end_ms"] for e in events), default=0)

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.sendto(control(True), (IP, PORT))

    bulb_ctrl = BulbController()
    bulb_ctrl.snapshot()
    bulb_ctrl.start()

    frame_interval = 1.0 / FPS
    frame_index = 0
    start_perf = time.perf_counter()
    next_tick = start_perf
    last_event_id = None
    last_bulb_event_id: dict = {bid: None for bid in BULB_IDS}

    print(f"Rendering. Timeline length {total_ms/1000:.1f}s. Ctrl+C to stop early.")

    try:
        while True:
            elapsed_ms = (time.perf_counter() - start_perf) * 1000.0
            if total_ms > 0 and elapsed_ms > total_ms + 250:
                break

            buffer = [(0, 0, 0)] * PIXELS
            event = find_active_event(strip_events, elapsed_ms)

            event_id = id(event) if event is not None else None
            if event_id != last_event_id:
                last_event_id = event_id
                if event is not None:
                    print(
                        f"[{elapsed_ms/1000:6.2f}s] pattern='{event['pattern']}' "
                        f"segments={event.get('segments', 'all')} color={event.get('color')}"
                    )

            if event is not None:
                segments = resolve_segments(event.get("segments", "all"), PIXELS)
                color = tuple(event.get("color", [255, 255, 255]))
                params = event.get("params", {})
                duration_ms = max(1, event["end_ms"] - event["start_ms"])
                t_ms = elapsed_ms - event["start_ms"]
                progress = max(0.0, min(1.0, t_ms / duration_ms))
                ctx = PatternContext(
                    segments=segments, color=color, params=params,
                    t_ms=t_ms, duration_ms=duration_ms, progress=progress,
                    now_ms=elapsed_ms, audio=audio_analyzer,
                    frame_index=frame_index,
                )
                pattern_fn = PATTERNS.get(event["pattern"])
                if pattern_fn is not None:
                    pattern_fn(buffer, ctx)

            sock.sendto(frame(buffer), (IP, PORT))

            for bid in BULB_IDS:
                stream = bulb_event_streams[bid]
                if not stream:
                    continue
                bulb_event = find_active_event(stream, elapsed_ms)
                bulb_event_id = id(bulb_event) if bulb_event is not None else None
                if bulb_event_id != last_bulb_event_id[bid]:
                    last_bulb_event_id[bid] = bulb_event_id
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
                next_tick = time.perf_counter()

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


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python led_renderer.py <song_path> [json_path]")
        sys.exit(1)
    run(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
