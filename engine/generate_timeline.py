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

Requires: librosa, numpy, soundfile
"""

from __future__ import annotations

import argparse
import json
import os
import random
from typing import List, Optional, Tuple

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


def groups_to_events(groups: List[dict], avg_beat_dur: float, use_zones: bool,
                      rng: random.Random) -> List[dict]:
    events = []
    zone_cycle_idx = 0

    def next_zone():
        nonlocal zone_cycle_idx
        z = ZONES[zone_cycle_idx % len(ZONES)]
        zone_cycle_idx += 1
        return z

    for i, g in enumerate(groups):
        start_ms = int(g["start"] * 1000)
        end_ms = int(g["end"] * 1000)
        color = COLOR_PALETTE[i % len(COLOR_PALETTE)]

        if g["label"] == "drop":
            flash_dur = min(0.3, avg_beat_dur * 0.6)
            for b in g["beats"]:
                events.append({
                    "pattern": "beats",
                    "start_ms": int(b * 1000),
                    "end_ms": int((b + flash_dur) * 1000),
                    "segments": "all",
                    "color": color,
                    "params": {"attack_ms": 25},
                })
            if not g["beats"]:
                events.append({
                    "pattern": "alt_band", "start_ms": start_ms, "end_ms": end_ms,
                    "segments": "all", "color": color,
                    "params": {"band_size": 3, "speed": 10},
                })

        elif g["label"] == "buildup":
            streak = g.get("rise_streak", 1)
            density = min(0.6, 0.12 + 0.08 * streak)
            segs = next_zone() if use_zones else "all"
            events.append({
                "pattern": "sparkle", "start_ms": start_ms, "end_ms": end_ms,
                "segments": segs, "color": color,
                "params": {"density": round(density, 2)},
            })

        elif g["label"] == "vocal":
            pastel = PASTEL_PALETTE[i % len(PASTEL_PALETTE)]
            segs = next_zone() if use_zones else "all"
            events.append({
                "pattern": "pulse", "start_ms": start_ms, "end_ms": end_ms,
                "segments": segs, "color": pastel,
                "params": {"cycles": max(1, round((g["end"] - g["start"]) / 2))},
            })

        else:  # filler, tiered by energy
            tier = g["tier"]
            segs = next_zone() if use_zones else "all"
            if tier == "low":
                events.append({
                    "pattern": "hold", "start_ms": start_ms, "end_ms": end_ms,
                    "segments": segs, "color": [c // 3 for c in color], "params": {},
                })
            elif tier == "medium":
                choice = rng.choice(["rainbow", "comet"])
                if choice == "rainbow":
                    events.append({
                        "pattern": "rainbow", "start_ms": start_ms, "end_ms": end_ms,
                        "segments": segs, "color": color, "params": {"speed": 0.8},
                    })
                else:
                    events.append({
                        "pattern": "comet", "start_ms": start_ms, "end_ms": end_ms,
                        "segments": segs, "color": color,
                        "params": {"length": 6, "passes": 2},
                    })
            else:  # high, but not a full drop
                choice = rng.choice(["alt_band", "snake"])
                if choice == "alt_band":
                    events.append({
                        "pattern": "alt_band", "start_ms": start_ms, "end_ms": end_ms,
                        "segments": segs, "color": color,
                        "params": {"band_size": 3, "speed": 6},
                    })
                else:
                    events.append({
                        "pattern": "snake", "start_ms": start_ms, "end_ms": end_ms,
                        "segments": segs, "color": color,
                        "params": {"length": 6, "passes": 2},
                    })

    return events


def add_intro_outro(events: List[dict], duration_sec: float) -> List[dict]:
    intro_end_ms = int(INTRO_FADE_SEC * 1000)
    outro_start_ms = int((duration_sec - OUTRO_FADE_SEC) * 1000)

    events = [e for e in events if e["start_ms"] >= intro_end_ms and e["end_ms"] <= outro_start_ms]

    intro = {
        "pattern": "fade", "start_ms": 0, "end_ms": intro_end_ms,
        "segments": "all", "color": [255, 255, 255], "params": {"mode": "in"},
    }
    outro = {
        "pattern": "fade", "start_ms": outro_start_ms, "end_ms": int(duration_sec * 1000),
        "segments": "all", "color": [255, 255, 255], "params": {"mode": "out"},
    }
    return [intro] + events + [outro]


def generate(song_path: str, group_beats: int = DEFAULT_GROUP_BEATS,
             use_zones: bool = False, seed: int = 42) -> dict:
    rng = random.Random(seed)
    analysis = analyze(song_path)
    groups, avg_beat_dur = build_groups(analysis, group_beats)
    groups = classify_groups(groups)
    events = groups_to_events(groups, avg_beat_dur, use_zones, rng)
    events = add_intro_outro(events, analysis["duration_sec"])
    events.sort(key=lambda e: e["start_ms"])

    print(f"Detected tempo: {analysis['tempo']:.1f} BPM, "
          f"duration: {analysis['duration_sec']:.1f}s, "
          f"{len(groups)} groups -> {len(events)} events")
    label_counts = {}
    for g in groups:
        label_counts[g["label"]] = label_counts.get(g["label"], 0) + 1
    print("Group breakdown:", label_counts)

    return {"events": events}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Auto-generate an LED pattern timeline from a song.")
    parser.add_argument("song_path")
    parser.add_argument("output_path", nargs="?", default=None)
    parser.add_argument("--group-beats", type=int, default=DEFAULT_GROUP_BEATS,
                         help="Beats per analysis group (default 4, ~1 bar in 4/4)")
    parser.add_argument("--zones", action="store_true",
                         help="Rotate non-drop events across named zones instead of always 'all'")
    parser.add_argument("--seed", type=int, default=42, help="Random seed for filler pattern choice")
    args = parser.parse_args()

    output_path = args.output_path or (os.path.splitext(args.song_path)[0] + ".json")
    timeline = generate(args.song_path, args.group_beats, args.zones, args.seed)

    with open(output_path, "w") as f:
        json.dump(timeline, f, indent=2)
    print(f"Wrote {output_path}")
