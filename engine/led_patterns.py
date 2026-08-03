"""
Pattern engine for the 45-segment LED strip.

Every pattern function has the signature:
    pattern_fn(buffer: List[Tuple[int,int,int]], ctx: PatternContext) -> None

It mutates `buffer` in place, only touching indices in ctx.segments.
`buffer` is reset to all-black by the player before each active pattern runs,
since only one pattern is active at a time.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple

RGB = Tuple[int, int, int]

# Named zones -> inclusive (start, end) segment index ranges.
ZONES: Dict[str, Tuple[int, int]] = {
    "table": (0, 5),
    "bed": (6, 16),
    "kitchen": (17, 24),
    "main": (25, 33),
    "final": (34, 44),
}


def _parse_segment_token(token: str, total_pixels: int) -> List[int]:
    token = token.strip()
    if not token:
        return []
    lower = token.lower()
    if lower == "all":
        return list(range(total_pixels))
    if lower in ZONES:
        start, end = ZONES[lower]
        return list(range(start, end + 1))
    if "-" in token:
        lo, hi = token.split("-", 1)
        return list(range(int(lo.strip()), int(hi.strip()) + 1))
    return [int(token)]


@dataclass
class PatternContext:
    segments: List[int]          # which LED indices this event controls
    color: RGB                   # primary color from the JSON event
    params: dict                 # pattern-specific params from JSON
    t_ms: float                  # elapsed ms *since this event started*
    duration_ms: float           # this event's total duration
    progress: float              # t_ms / duration_ms, clamped 0..1
    now_ms: float                # absolute elapsed ms in the song (for audio sync)
    audio: Optional["AudioAnalyzer"] = None  # only set if needed
    frame_index: int = 0         # global frame counter, useful for randomness seeding


def resolve_segments(segments, total_pixels: int) -> List[int]:
    """Accepts:
      - "all"
      - a list of ints, e.g. [0, 1, 2]
      - a zone name, e.g. "Kitchen" (case-insensitive)
      - a numeric range string, e.g. "0-5"
      - a comma-separated combo of any of the above, e.g. "Table, 20-24, Final"
    """
    if isinstance(segments, str):
        result: List[int] = []
        for token in segments.split(","):
            result.extend(_parse_segment_token(token, total_pixels))
        # de-dupe while preserving order
        return list(dict.fromkeys(result))
    return list(segments)


def _scale(color: RGB, factor: float) -> RGB:
    factor = max(0.0, min(1.0, factor))
    return (int(color[0] * factor), int(color[1] * factor), int(color[2] * factor))


def _hue_to_rgb(h: float) -> RGB:
    h = h % 1.0
    i = int(h * 6)
    f = h * 6 - i
    q = 1 - f
    t = f
    table = [(1, t, 0), (q, 1, 0), (0, 1, t), (0, q, 1), (t, 0, 1), (1, 0, q)]
    r, g, b = table[i % 6]
    return int(r * 255), int(g * 255), int(b * 255)


# ---------------------------------------------------------------------------
# Patterns
# ---------------------------------------------------------------------------

def pattern_beats(buffer, ctx: PatternContext):
    """Quick attack, then decay to zero over the rest of the event's duration.
    Great for one-shot hits triggered on individual beats/kicks."""
    attack_ms = ctx.params.get("attack_ms", 40)
    if ctx.t_ms < attack_ms:
        factor = ctx.t_ms / attack_ms
    else:
        remaining = max(1.0, ctx.duration_ms - attack_ms)
        factor = max(0.0, 1.0 - (ctx.t_ms - attack_ms) / remaining)
    color = _scale(ctx.color, factor)
    for seg in ctx.segments:
        buffer[seg] = color


def pattern_sparkle(buffer, ctx: PatternContext):
    """Random subset of segments lit each frame ('twinkle')."""
    density = ctx.params.get("density", 0.25)
    seed = f"{ctx.frame_index}:{ctx.segments}"
    rng = random.Random(seed)
    for seg in ctx.segments:
        if rng.random() < density:
            buffer[seg] = ctx.color


def pattern_rainbow(buffer, ctx: PatternContext):
    """Hue gradient across the segments, cycling over the event duration."""
    speed = ctx.params.get("speed", 1.0)  # full cycles over duration
    n = max(1, len(ctx.segments))
    for i, seg in enumerate(ctx.segments):
        hue = (i / n) + ctx.progress * speed
        buffer[seg] = _hue_to_rgb(hue)


def pattern_snake(buffer, ctx: PatternContext):
    """A short trail travels down the segment list, entering and exiting cleanly."""
    length = ctx.params.get("length", 4)
    passes = ctx.params.get("passes", 1)
    n = len(ctx.segments)
    span = n + length
    head = (ctx.progress * passes % 1.0) * span - length
    for k in range(length):
        idx = int(head) - k
        if 0 <= idx < n:
            factor = 1.0 - (k / length)
            buffer[ctx.segments[idx]] = _scale(ctx.color, factor)


def pattern_criss_cross(buffer, ctx: PatternContext):
    """Two dots start at opposite ends of the segment list and cross paths."""
    n = len(ctx.segments)
    if n == 0:
        return
    passes = ctx.params.get("passes", 1)
    color_b = tuple(ctx.params.get("color_b", ctx.color))
    pos_a = (ctx.progress * passes % 1.0) * (n - 1)
    pos_b = (n - 1) - pos_a
    idx_a = int(round(pos_a))
    idx_b = int(round(pos_b))
    buffer[ctx.segments[idx_a]] = ctx.color
    buffer[ctx.segments[idx_b]] = color_b


def pattern_alt_band(buffer, ctx: PatternContext):
    """Alternating stripes of color / black that can march along the strip."""
    band_size = ctx.params.get("band_size", 3)
    speed = ctx.params.get("speed", 5)  # segments shifted per second
    offset = int((ctx.t_ms / 1000.0) * speed)
    for i, seg in enumerate(ctx.segments):
        if ((i + offset) // band_size) % 2 == 0:
            buffer[seg] = ctx.color


def pattern_fade(buffer, ctx: PatternContext):
    """Fade in, fade out, or fade in-then-out (triangular) over the duration."""
    mode = ctx.params.get("mode", "in_out")
    if mode == "in":
        factor = ctx.progress
    elif mode == "out":
        factor = 1.0 - ctx.progress
    else:  # in_out
        factor = 1.0 - abs(2 * ctx.progress - 1)
    color = _scale(ctx.color, factor)
    for seg in ctx.segments:
        buffer[seg] = color


def pattern_scramble(buffer, ctx: PatternContext):
    """Randomly reassigns colors across segments, reshuffling on an interval."""
    interval_ms = ctx.params.get("interval_ms", 150)
    colors = ctx.params.get("colors")
    colors = [tuple(c) for c in colors] if colors else [ctx.color]
    tick = int(ctx.t_ms // interval_ms)
    seed = f"{tick}:{ctx.segments}"
    rng = random.Random(seed)
    segs = list(ctx.segments)
    rng.shuffle(segs)
    for i, seg in enumerate(segs):
        buffer[seg] = colors[i % len(colors)]


def pattern_stack(buffer, ctx: PatternContext):
    """Segments fill up one by one (progress bar style)."""
    n = len(ctx.segments)
    filled = int(ctx.progress * n)
    for i in range(min(filled + 1, n)):
        buffer[ctx.segments[i]] = ctx.color


def pattern_audio_spectrum(buffer, ctx: PatternContext):
    """Live FFT of the song, mapped across the event's segments."""
    if ctx.audio is None:
        return
    n = len(ctx.segments)
    if n == 0:
        return
    sensitivity = ctx.params.get("sensitivity", 30.0)
    rainbow_mode = ctx.params.get("rainbow", True)
    levels = ctx.audio.get_bin_levels(ctx.now_ms, n, sensitivity=sensitivity)
    for i, seg in enumerate(ctx.segments):
        level = levels[i]
        if rainbow_mode:
            buffer[seg] = _scale(_hue_to_rgb(i / n), level)
        else:
            buffer[seg] = _scale(ctx.color, level)


def pattern_pulse(buffer, ctx: PatternContext):
    """Smooth breathing brightness (sine wave), repeating N times over the duration."""
    cycles = ctx.params.get("cycles", 3)
    phase = ctx.progress * cycles * 2 * math.pi
    factor = (math.sin(phase - math.pi / 2) + 1) / 2  # starts at 0, smooth in/out
    color = _scale(ctx.color, factor)
    for seg in ctx.segments:
        buffer[seg] = color


def pattern_bounce(buffer, ctx: PatternContext):
    """A single dot with a trail bounces back and forth between the two ends."""
    n = len(ctx.segments)
    if n == 0:
        return
    passes = ctx.params.get("passes", 3)
    trail = ctx.params.get("trail", 3)
    cycle_pos = (ctx.progress * passes) % 1.0
    t = cycle_pos * 2 if cycle_pos < 0.5 else 2 - cycle_pos * 2  # 0 -> 1 -> 0 triangle wave
    head = t * (n - 1)
    for k in range(trail):
        idx = int(round(head)) - k
        if 0 <= idx < n:
            factor = 1.0 - (k / trail)
            buffer[ctx.segments[idx]] = _scale(ctx.color, factor)


def pattern_comet(buffer, ctx: PatternContext):
    """A trail that loops continuously around the segment list (wraps at the end)."""
    n = len(ctx.segments)
    if n == 0:
        return
    length = ctx.params.get("length", 5)
    passes = ctx.params.get("passes", 2)
    pos = (ctx.progress * passes % 1.0) * n
    for k in range(length):
        idx = (int(pos) - k) % n
        factor = 1.0 - (k / length)
        buffer[ctx.segments[idx]] = _scale(ctx.color, factor)


def pattern_twinkle_fade(buffer, ctx: PatternContext):
    """Like sparkle, but each spark fades out smoothly over fade_ms instead of
    snapping on/off instantly. More organic/persistent 'starfield' feel."""
    spawn_chance = ctx.params.get("spawn_chance", 0.05)
    fade_ms = ctx.params.get("fade_ms", 600)
    bucket_ms = 50
    ticks_back = int(fade_ms // bucket_ms) + 1
    current_tick = int(ctx.t_ms // bucket_ms)

    for seg in ctx.segments:
        best_factor = 0.0
        for back in range(ticks_back):
            tick = current_tick - back
            if tick < 0:
                break
            rng = random.Random(f"{seg}:{tick}")
            if rng.random() < spawn_chance:
                age_ms = back * bucket_ms + (ctx.t_ms % bucket_ms)
                factor = max(0.0, 1.0 - (age_ms / fade_ms))
                best_factor = max(best_factor, factor)
        if best_factor > 0:
            buffer[seg] = _scale(ctx.color, best_factor)


def pattern_hold(buffer, ctx: PatternContext):
    """Just holds a solid, unchanging color for the whole duration. The 'blank' pattern."""
    for seg in ctx.segments:
        buffer[seg] = ctx.color


def pattern_rainbow_jump(buffer, ctx: PatternContext):
    """Like rainbow, but jumps between discrete colors instead of smoothly
    cycling -- the whole segment set flashes to the next color in the sequence.
    Pass params.colors for a custom palette, otherwise auto-spaced hues are used."""
    steps = ctx.params.get("steps", 8)
    interval_ms = max(1.0, ctx.duration_ms / steps)
    index = min(steps - 1, int(ctx.t_ms // interval_ms))

    custom_colors = ctx.params.get("colors")
    if custom_colors:
        color = tuple(custom_colors[index % len(custom_colors)])
    else:
        color = _hue_to_rgb(index / steps)

    for seg in ctx.segments:
        buffer[seg] = color


PATTERNS: Dict[str, Callable] = {
    "beats": pattern_beats,
    "sparkle": pattern_sparkle,
    "rainbow": pattern_rainbow,
    "snake": pattern_snake,
    "criss_cross": pattern_criss_cross,
    "alt_band": pattern_alt_band,
    "fade": pattern_fade,
    "scramble": pattern_scramble,
    "stack": pattern_stack,
    "audio_spectrum": pattern_audio_spectrum,
    "pulse": pattern_pulse,
    "bounce": pattern_bounce,
    "comet": pattern_comet,
    "twinkle_fade": pattern_twinkle_fade,
    "hold": pattern_hold,
    "rainbow_jump": pattern_rainbow_jump,
}
