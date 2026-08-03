"""
Analyzes a song's tempo, beat grid, energy, and harmonic/percussive balance,
then auto-generates a pattern timeline JSON compatible with led_player.py.

Heuristics (per ~1-bar group of beats, in priority order):
    1. Drop      -- energy spikes hard above the recent baseline
                    -> rapid 'beats' flash on every beat in that bar
    2. Buildup   -- energy trending upward over consecutive bars
                    -> 'sparkle', density increases the longer the rise continues
    3. Vocal-ish -- harmonic energy dominates percussive (HPSS ratio)
                    and it isn't a drop -> calm 'pulse'
    4. Filler    -- everything else, tiered by energy percentile into
                    hold / rainbow / comet / alt_band / snake

This is a heuristic, not true vocal isolation (that needs source separation
like Demucs/Spleeter). It works reasonably well on typical pop/EDM structure
but will need manual touch-up on unusual tracks. Treat the output JSON as a
strong first draft, not a final mix.

Usage:
    python generate_timeline.py song.mp3 [output.json] [--group-beats 4] [--zones]

Every event carries an `id` field selecting its target device:
    id=1 -> the 45-pixel LED strip (Main Light)
    id=2, 3 -> Kitchen bulbs 1 & 2 (paired, share color)
    id=4 -> Living Room bulb
    id=5 -> Hallway bulb
Bulb events only carry `color` + `params`; they are single points, not segments.
led_player restores bulbs to their previous state (bulb_states.json) on exit.

Requires: librosa, numpy, soundfile
"""

from __future__ import annotations

import argparse
import json
import os
import random
import time
from typing import Dict, List, Optional, Tuple

import librosa
import numpy as np

# --- Tunables -----------------------------------------------------------

DEFAULT_GROUP_BEATS = 4      # beats per analysis group (roughly one bar in 4/4)
BASELINE_LOOKBACK = 4        # how many prior groups define the "recent baseline"
RISE_THRESHOLD = 1.15        # group must exceed baseline * this to count as "rising"
DROP_THRESHOLD = 1.55        # group must exceed baseline * this to count as a "drop"
VOCAL_HARMONIC_RATIO = 0.55  # harmonic energy share above which we call it "vocal-ish"
INTRO_FADE_SEC = 2.5
OUTRO_FADE_SEC = 3.0

COLOR_PALETTE = [
    [255, 60, 60], [60, 160, 255], [255, 200, 60],
    [120, 255, 120], [200, 80, 255], [255, 120, 180],
]
PASTEL_PALETTE = [
    [255, 210, 190], [200, 220, 255], [255, 240, 200], [220, 200, 255],
]

ZONES = ["Table", "Bed", "Kitchen", "Main", "Final"]

# Zone routing for the "special effects" layer. The player renders one event
# at a time (no layering), so these are targeting choices per event, not
# simultaneous layers -- rotating them gives the strip a multi-zone feel.
SPECIAL_ZONES = ["Main, Bed", "Bed", "Main", "Bed, Main, Final", "Main, Kitchen"]
SPECTRUM_ZONES = ["Table", "Table, Kitchen", "all"]

# Anti-repeat pools per group label. Order-agnostic; we sample without
# picking the same pattern twice in a row per label.
BUILDUP_POOL = ["sparkle", "twinkle_fade", "stack", "scramble", "bounce", "comet"]
VOCAL_POOL = ["pulse", "comet", "criss_cross", "rainbow", "bounce", "twinkle_fade"]
DROP_ALT_POOL = ["rainbow_jump", "scramble", "stack", "alt_band"]
FILLER_LOW_POOL = ["hold", "fade", "twinkle_fade", "pulse"]
FILLER_MED_POOL = ["rainbow", "comet", "snake", "criss_cross", "bounce"]
FILLER_HIGH_POOL = ["alt_band", "snake", "bounce", "scramble", "rainbow_jump", "comet"]

# Every Nth group is replaced with an audio_spectrum showcase.
SPECTRUM_EVERY_N_GROUPS = 6

STRIP_DEVICE_ID = 1
BULB_IDS = [2, 3, 4, 5]  # 2/3 = Kitchen pair, 4 = Living Room, 5 = Hallway

# Patterns that translate cleanly to a single color+brightness bulb.
BULB_PATTERNS = {
    "drop": ["beats", "pulse", "scramble", "rainbow_jump"],
    "buildup": ["pulse", "fade", "scramble"],
    "vocal": ["pulse", "hold", "fade"],
    "filler_low": ["hold", "fade", "pulse"],
    "filler_med": ["pulse", "rainbow_jump", "fade"],
    "filler_high": ["scramble", "rainbow_jump", "pulse"],
}


def analyze(song_path: str):
    y, sr = librosa.load(song_path, sr=None, mono=True)
    duration_sec = len(y) / sr

    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
    tempo = float(np.asarray(tempo).reshape(-1)[0]) if np.asarray(tempo).size else 120.0
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    if len(beat_times) < 2:
        # Fallback: synthesize a beat grid from a guessed tempo so grouping still works.
        bpm = tempo if tempo else 120.0
        step = 60.0 / bpm
        beat_times = np.arange(0, duration_sec, step)

    rms = librosa.feature.rms(y=y)[0]
    rms_times = librosa.frames_to_time(np.arange(len(rms)), sr=sr)

    y_harm, y_perc = librosa.effects.hpss(y)
    rms_harm = librosa.feature.rms(y=y_harm)[0]
    rms_perc = librosa.feature.rms(y=y_perc)[0]
    eps = 1e-9
    harmonic_ratio = rms_harm / (rms_harm + rms_perc + eps)
    harm_times = librosa.frames_to_time(np.arange(len(harmonic_ratio)), sr=sr)

    return {
        "duration_sec": duration_sec,
        "tempo": tempo,
        "beat_times": beat_times,
        "rms": rms,
        "rms_times": rms_times,
        "harmonic_ratio": harmonic_ratio,
        "harm_times": harm_times,
    }


def _mean_in_range(values, times, start, end) -> float:
    mask = (times >= start) & (times < end)
    if not mask.any():
        return float(values.mean()) if len(values) else 0.0
    return float(values[mask].mean())


def build_groups(analysis: dict, group_beats: int) -> List[dict]:
    beat_times = analysis["beat_times"]
    duration = analysis["duration_sec"]
    avg_beat_dur = float(np.diff(beat_times).mean()) if len(beat_times) > 1 else 0.5

    boundaries = list(beat_times[::group_beats])
    if not boundaries or boundaries[0] > 0:
        boundaries.insert(0, 0.0)
    boundaries.append(duration)

    groups = []
    for i in range(len(boundaries) - 1):
        start, end = boundaries[i], boundaries[i + 1]
        if end - start < 0.05:
            continue
        rms_avg = _mean_in_range(analysis["rms"], analysis["rms_times"], start, end)
        harmonic_avg = _mean_in_range(analysis["harmonic_ratio"], analysis["harm_times"], start, end)
        beats_in_group = [b for b in beat_times if start <= b < end]
        groups.append({
            "start": start, "end": end,
            "rms": rms_avg, "harmonic_ratio": harmonic_avg,
            "beats": beats_in_group,
        })

    all_rms = np.array([g["rms"] for g in groups]) if groups else np.array([0.0])
    p33, p66 = np.percentile(all_rms, [33, 66])
    for g in groups:
        g["tier"] = "low" if g["rms"] <= p33 else ("high" if g["rms"] >= p66 else "medium")

    return groups, avg_beat_dur


def classify_groups(groups: List[dict]) -> List[dict]:
    rise_streak = 0
    for i, g in enumerate(groups):
        lookback = groups[max(0, i - BASELINE_LOOKBACK):i]
        baseline = float(np.mean([b["rms"] for b in lookback])) if lookback else g["rms"]
        baseline = max(baseline, 1e-6)

        is_drop = g["rms"] > baseline * DROP_THRESHOLD
        is_rising = (not is_drop) and g["rms"] > baseline * RISE_THRESHOLD
        is_vocal = (not is_drop) and (not is_rising) and g["harmonic_ratio"] > VOCAL_HARMONIC_RATIO

        if is_drop:
            g["label"] = "drop"
            rise_streak = 0
        elif is_rising:
            g["label"] = "buildup"
            rise_streak += 1
            g["rise_streak"] = rise_streak
        elif is_vocal:
            g["label"] = "vocal"
            rise_streak = 0
        else:
            g["label"] = "filler"
            rise_streak = 0
    return groups


def _pick_no_repeat(pool: List[str], last: Optional[str], rng: random.Random) -> str:
    choices = [p for p in pool if p != last] or pool
    return rng.choice(choices)


def _build_event(pattern: str, start_ms: int, end_ms: int, segments, color,
                  duration_sec: float, streak: int, rng: random.Random) -> dict:
    """Build a single event dict with sensible per-pattern params."""
    params: dict = {}
    if pattern == "sparkle":
        density = min(0.6, 0.15 + 0.06 * streak + rng.random() * 0.1)
        params = {"density": round(density, 2)}
    elif pattern == "twinkle_fade":
        params = {
            "spawn_chance": round(0.03 + rng.random() * 0.06, 3),
            "fade_ms": rng.choice([400, 600, 800, 1000]),
        }
    elif pattern == "stack":
        params = {}
    elif pattern == "scramble":
        params = {
            "interval_ms": rng.choice([120, 150, 200, 250]),
            "colors": [color, [255 - color[0], 255 - color[1], 255 - color[2]]],
        }
    elif pattern == "bounce":
        params = {"passes": rng.randint(2, 5), "trail": rng.randint(2, 5)}
    elif pattern == "comet":
        params = {"length": rng.randint(4, 8), "passes": rng.randint(1, 3)}
    elif pattern == "pulse":
        params = {"cycles": max(1, round(duration_sec / rng.choice([1.5, 2.0, 2.5])))}
    elif pattern == "criss_cross":
        params = {
            "passes": rng.randint(1, 3),
            "color_b": [255 - color[0], 255 - color[1], 255 - color[2]],
        }
    elif pattern == "rainbow":
        params = {"speed": round(0.5 + rng.random() * 1.0, 2)}
    elif pattern == "rainbow_jump":
        params = {"steps": rng.choice([6, 8, 10, 12])}
    elif pattern == "snake":
        params = {"length": rng.randint(4, 8), "passes": rng.randint(1, 3)}
    elif pattern == "alt_band":
        params = {"band_size": rng.choice([2, 3, 4]), "speed": rng.choice([4, 6, 8, 10])}
    elif pattern == "hold":
        params = {}
    elif pattern == "fade":
        params = {"mode": rng.choice(["in_out", "in", "out"])}
    elif pattern == "audio_spectrum":
        params = {
            "sensitivity": rng.choice([25.0, 30.0, 40.0]),
            "rainbow": rng.random() < 0.7,
        }
    return {
        "id": STRIP_DEVICE_ID,
        "pattern": pattern, "start_ms": start_ms, "end_ms": end_ms,
        "segments": segments, "color": list(color), "params": params,
    }


def groups_to_events(groups: List[dict], avg_beat_dur: float, segments_mode: str,
                      rng: random.Random) -> List[dict]:
    """segments_mode:
        "all"   -- every event targets the whole strip
        "zones" -- rotate through Main/Bed/Kitchen/etc. subsets
        "mix"   -- ~40% "all", rest zone subsets (most dynamic)
    """
    events = []
    last_by_label: Dict[str, Optional[str]] = {
        "drop": None, "buildup": None, "vocal": None,
        "filler_low": None, "filler_med": None, "filler_high": None,
    }
    special_idx = 0
    spectrum_idx = 0

    def next_special_zone() -> str:
        nonlocal special_idx
        if segments_mode == "all":
            return "all"
        if segments_mode == "mix" and rng.random() < 0.4:
            return "all"
        z = SPECIAL_ZONES[special_idx % len(SPECIAL_ZONES)]
        special_idx += 1
        return z

    def next_spectrum_zone() -> str:
        nonlocal spectrum_idx
        if segments_mode == "all":
            return "all"
        z = SPECTRUM_ZONES[spectrum_idx % len(SPECTRUM_ZONES)]
        spectrum_idx += 1
        return z

    palette = list(COLOR_PALETTE)
    rng.shuffle(palette)

    for i, g in enumerate(groups):
        start_ms = int(g["start"] * 1000)
        end_ms = int(g["end"] * 1000)
        dur_sec = g["end"] - g["start"]
        color = palette[i % len(palette)]

        # Periodic audio_spectrum showcase overrides the group's default pattern.
        # Skips drops so we don't dilute the biggest moments.
        if (g["label"] != "drop"
                and i > 0
                and i % SPECTRUM_EVERY_N_GROUPS == 0):
            segs = next_spectrum_zone()
            events.append(_build_event(
                "audio_spectrum", start_ms, end_ms, segs, color, dur_sec, 0, rng))
            continue

        if g["label"] == "drop":
            # Beat-flash the strip, but occasionally swap to an alternate
            # high-impact pattern for variety across drops.
            use_alt = rng.random() < 0.35 or not g["beats"]
            if use_alt:
                pat = _pick_no_repeat(DROP_ALT_POOL, last_by_label["drop"], rng)
                last_by_label["drop"] = pat
                events.append(_build_event(
                    pat, start_ms, end_ms, "all", color, dur_sec, 0, rng))
            else:
                flash_dur = min(0.3, avg_beat_dur * 0.6)
                for b in g["beats"]:
                    events.append({
                        "id": STRIP_DEVICE_ID,
                        "pattern": "beats",
                        "start_ms": int(b * 1000),
                        "end_ms": int((b + flash_dur) * 1000),
                        "segments": "all",
                        "color": list(color),
                        "params": {"attack_ms": 25},
                    })

        elif g["label"] == "buildup":
            pat = _pick_no_repeat(BUILDUP_POOL, last_by_label["buildup"], rng)
            last_by_label["buildup"] = pat
            segs = next_special_zone()
            streak = g.get("rise_streak", 1)
            events.append(_build_event(
                pat, start_ms, end_ms, segs, color, dur_sec, streak, rng))

        elif g["label"] == "vocal":
            pat = _pick_no_repeat(VOCAL_POOL, last_by_label["vocal"], rng)
            last_by_label["vocal"] = pat
            pastel = PASTEL_PALETTE[i % len(PASTEL_PALETTE)]
            segs = next_special_zone()
            events.append(_build_event(
                pat, start_ms, end_ms, segs, pastel, dur_sec, 0, rng))

        else:  # filler
            tier = g["tier"]
            if tier == "low":
                pool, key = FILLER_LOW_POOL, "filler_low"
                use_color = [c // 3 for c in color]
            elif tier == "medium":
                pool, key = FILLER_MED_POOL, "filler_med"
                use_color = color
            else:
                pool, key = FILLER_HIGH_POOL, "filler_high"
                use_color = color
            pat = _pick_no_repeat(pool, last_by_label[key], rng)
            last_by_label[key] = pat
            segs = next_special_zone()
            events.append(_build_event(
                pat, start_ms, end_ms, segs, use_color, dur_sec, 0, rng))

    return events


def _build_bulb_event(bulb_id: int, pattern: str, start_ms: int, end_ms: int,
                       color, duration_sec: float, rng: random.Random) -> dict:
    """Bulbs have no segments -- they're single points. Reuse _build_event's
    param picker but strip the 'segments' key and stamp the bulb id."""
    ev = _build_event(pattern, start_ms, end_ms, "all", color, duration_sec, 1, rng)
    ev["id"] = bulb_id
    ev.pop("segments", None)
    return ev


def groups_to_bulb_events(groups: List[dict], rng: random.Random) -> List[dict]:
    """One event per group per bulb. Kitchen pair (ids 2 & 3) shares color so
    the two bulbs feel like one zone; living-room (4) and hallway (5) get
    independent colors picked from the palette."""
    events: List[dict] = []
    last_by_key: Dict[str, Optional[str]] = {}

    def pick_bulb_pattern(label: str, tier: Optional[str]) -> str:
        if label == "filler":
            key = f"filler_{tier or 'med'}"
        else:
            key = label
        pool = BULB_PATTERNS.get(key, BULB_PATTERNS["vocal"])
        last = last_by_key.get(key)
        pat = _pick_no_repeat(pool, last, rng)
        last_by_key[key] = pat
        return pat

    for i, g in enumerate(groups):
        start_ms = int(g["start"] * 1000)
        end_ms = int(g["end"] * 1000)
        dur_sec = g["end"] - g["start"]
        label = g["label"]
        tier = g.get("tier")

        # Kitchen pair -- same color, same pattern so both bulbs pulse together.
        kitchen_color = COLOR_PALETTE[i % len(COLOR_PALETTE)]
        kitchen_pattern = pick_bulb_pattern(label, tier)
        for bid in (2, 3):
            events.append(_build_bulb_event(
                bid, kitchen_pattern, start_ms, end_ms,
                kitchen_color, dur_sec, rng))

        # Living room + hallway -- each their own accent, softer palette for vocals.
        for bid in (4, 5):
            if label == "vocal":
                c = PASTEL_PALETTE[(i + bid) % len(PASTEL_PALETTE)]
            else:
                c = COLOR_PALETTE[(i + bid * 2) % len(COLOR_PALETTE)]
            pat = pick_bulb_pattern(label, tier)
            events.append(_build_bulb_event(
                bid, pat, start_ms, end_ms, c, dur_sec, rng))

    return events


def add_intro_outro(events: List[dict], duration_sec: float) -> List[dict]:
    intro_end_ms = int(INTRO_FADE_SEC * 1000)
    outro_start_ms = int((duration_sec - OUTRO_FADE_SEC) * 1000)

    events = [e for e in events if e["start_ms"] >= intro_end_ms and e["end_ms"] <= outro_start_ms]

    intro = {
        "id": STRIP_DEVICE_ID,
        "pattern": "fade", "start_ms": 0, "end_ms": intro_end_ms,
        "segments": "all", "color": [255, 255, 255], "params": {"mode": "in"},
    }
    outro = {
        "id": STRIP_DEVICE_ID,
        "pattern": "fade", "start_ms": outro_start_ms, "end_ms": int(duration_sec * 1000),
        "segments": "all", "color": [255, 255, 255], "params": {"mode": "out"},
    }
    return [intro] + events + [outro]


def generate(song_path: str, group_beats: int = DEFAULT_GROUP_BEATS,
             segments_mode: str = "all", seed: Optional[int] = None,
             include_bulbs: bool = True) -> dict:
    if seed is None:
        seed = int.from_bytes(os.urandom(4), "big") ^ int(time.time() * 1000)
    rng = random.Random(seed)
    analysis = analyze(song_path)
    groups, avg_beat_dur = build_groups(analysis, group_beats)
    groups = classify_groups(groups)
    events = groups_to_events(groups, avg_beat_dur, segments_mode, rng)
    events = add_intro_outro(events, analysis["duration_sec"])
    if include_bulbs:
        bulb_events = groups_to_bulb_events(groups, rng)
        events.extend(bulb_events)
    events.sort(key=lambda e: (e["start_ms"], e.get("id", 1)))

    print(f"Seed: {seed}")
    print(f"Detected tempo: {analysis['tempo']:.1f} BPM, "
          f"duration: {analysis['duration_sec']:.1f}s, "
          f"{len(groups)} groups -> {len(events)} events")
    label_counts = {}
    for g in groups:
        label_counts[g["label"]] = label_counts.get(g["label"], 0) + 1
    print("Group breakdown:", label_counts)
    pattern_counts: Dict[str, int] = {}
    for e in events:
        pattern_counts[e["pattern"]] = pattern_counts.get(e["pattern"], 0) + 1
    print("Pattern breakdown:", pattern_counts)
    id_counts: Dict[int, int] = {}
    for e in events:
        eid = int(e.get("id", 1))
        id_counts[eid] = id_counts.get(eid, 0) + 1
    print("Device breakdown:", id_counts)

    return {"events": events}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Auto-generate an LED pattern timeline from a song.")
    parser.add_argument("song_path")
    parser.add_argument("output_path", nargs="?", default=None)
    parser.add_argument("--group-beats", type=int, default=DEFAULT_GROUP_BEATS,
                         help="Beats per analysis group (default 4, ~1 bar in 4/4)")
    parser.add_argument("--segments", choices=["all", "zones", "mix"], default=None,
                         help="How the Main light picks segments per event: "
                              "'all' = whole strip every time, "
                              "'zones' = rotate Bed/Kitchen/Main/etc. subsets, "
                              "'mix' = mostly zones with occasional 'all'. "
                              "Omit to be prompted.")
    parser.add_argument("--zones", action="store_true",
                         help="Shorthand for --segments zones (kept for backward compat).")
    parser.add_argument("--seed", type=int, default=None,
                         help="Random seed. Omit for a fresh seed each run (default) so no two JSONs match.")
    bulb_group = parser.add_mutually_exclusive_group()
    bulb_group.add_argument("--bulbs", dest="bulbs", action="store_true", default=None,
                             help="Include bulb (id 2..5) events in the timeline.")
    bulb_group.add_argument("--no-bulbs", dest="bulbs", action="store_false",
                             help="Strip-only timeline; do not emit bulb events.")
    args = parser.parse_args()

    include_bulbs = args.bulbs
    if include_bulbs is None:
        try:
            answer = input("Include bulbs (Kitchen/Living Room/Hallway) in animation? [Y/n] ").strip().lower()
        except EOFError:
            answer = ""
        include_bulbs = answer in ("", "y", "yes")

    segments_mode = args.segments
    if segments_mode is None and args.zones:
        segments_mode = "zones"
    if segments_mode is None:
        try:
            answer = input(
                "Main light segments -- [a]ll always, [z]ones only, or [m]ix zones + all? [a/z/M] "
            ).strip().lower()
        except EOFError:
            answer = ""
        segments_mode = {"a": "all", "z": "zones", "m": "mix"}.get(answer, "mix")
    print(f"Segments mode: {segments_mode}")

    output_path = args.output_path or (os.path.splitext(args.song_path)[0] + ".json")
    timeline = generate(args.song_path, args.group_beats, segments_mode, args.seed,
                        include_bulbs=include_bulbs)

    with open(output_path, "w") as f:
        json.dump(timeline, f, indent=2)
    print(f"Wrote {output_path}")
