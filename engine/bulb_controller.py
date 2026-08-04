"""
Talks to the Govee LAN bulbs (ids 2..5 in ../bulb_state.json) during song
playback and restores them to their previous state when playback ends.

The strip is driven directly by led_player.py -- this
module is only for the color+brightness-only bulbs. Kitchen has two bulbs
(ids 2 and 3); living room and hallway are ids 4 and 5.

Bulb network calls are slow (~50-200ms per command over LAN), so send() is
throttled per-bulb and only fires when the target color or brightness has
actually moved. Snapshot happens once at start; restore() replays power +
color + brightness to the previously-saved values.
"""

from __future__ import annotations

import copy
import json
import sys
import time
from pathlib import Path
from threading import Lock, Thread
from queue import Queue, Empty
from typing import Dict, Optional, Tuple

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LOCAL_DEPS = PROJECT_ROOT / ".pydeps"
if LOCAL_DEPS.exists() and str(LOCAL_DEPS) not in sys.path:
    sys.path.insert(0, str(LOCAL_DEPS))

try:
    from govee.api.lan import power as govee_power
    from govee.api.lan import brightness as govee_brightness
    from govee.api.lan import color as govee_color
    GOVEE_AVAILABLE = True
except ImportError:
    GOVEE_AVAILABLE = False

SERVER_STATE_FILE = PROJECT_ROOT / "bulb_state.json"
SNAPSHOT_FILE = Path(__file__).with_name("bulb_states.json")

# Per-bulb min interval between hardware commands (seconds). Govee LAN gets
# unhappy well under this; 4-5Hz per bulb is a safe ceiling.
MIN_SEND_INTERVAL = 0.22

# Only push a color update when at least one RGB channel moved this much.
COLOR_DELTA_THRESHOLD = 18
# Only push a brightness update when it moved this much (percent points).
BRIGHTNESS_DELTA_THRESHOLD = 6


def _rgb_to_hex(rgb: Tuple[int, int, int]) -> str:
    r, g, b = (max(0, min(255, int(c))) for c in rgb)
    return f"#{r:02x}{g:02x}{b:02x}"


class BulbController:
    def __init__(self) -> None:
        self.bulbs: Dict[str, dict] = self._load_server_state()
        self._last_sent: Dict[int, dict] = {}
        self._last_send_ts: Dict[int, float] = {}
        self._power_on: Dict[int, bool] = {}
        self._lock = Lock()
        self._snapshot: Optional[Dict[str, dict]] = None

        # Background sender: bulb commands are slow, so we don't want the
        # render loop to block on them. Latest-wins queue per bulb.
        self._queue: "Queue[Optional[Tuple[int, Tuple[int,int,int], int]]]" = Queue()
        self._worker: Optional[Thread] = None
        self._stop = False

    # -- state I/O --------------------------------------------------------

    def _load_server_state(self) -> Dict[str, dict]:
        if not SERVER_STATE_FILE.exists():
            return {}
        try:
            with open(SERVER_STATE_FILE, "r") as f:
                return json.load(f)
        except Exception:
            return {}

    def snapshot(self) -> None:
        """Save current bulb state so we can restore after playback."""
        self._snapshot = copy.deepcopy(self._load_server_state())
        with open(SNAPSHOT_FILE, "w") as f:
            json.dump(self._snapshot, f, indent=2)
        print(f"[bulbs] snapshot saved to {SNAPSHOT_FILE.name} "
              f"({len(self._snapshot)} bulbs)")

    def start(self) -> None:
        if not GOVEE_AVAILABLE:
            print("[bulbs] govee library not available -- bulb events will be no-ops.")
            return
        self._stop = False
        self._worker = Thread(target=self._run, daemon=True)
        self._worker.start()

    def stop(self) -> None:
        self._stop = True
        self._queue.put(None)
        if self._worker is not None:
            self._worker.join(timeout=2.0)

    # -- runtime API ------------------------------------------------------

    def send(self, bulb_id: int, rgb: Tuple[int, int, int], brightness_pct: int) -> None:
        """Queue a color+brightness update for a bulb. Throttled + change-gated."""
        if str(bulb_id) not in self.bulbs:
            return

        rgb = (max(0, min(255, int(rgb[0]))),
               max(0, min(255, int(rgb[1]))),
               max(0, min(255, int(rgb[2]))))
        brightness_pct = max(0, min(100, int(brightness_pct)))

        with self._lock:
            last = self._last_sent.get(bulb_id)
            now = time.perf_counter()
            if last is not None:
                dr = abs(last["rgb"][0] - rgb[0])
                dg = abs(last["rgb"][1] - rgb[1])
                db = abs(last["rgb"][2] - rgb[2])
                dbr = abs(last["brightness"] - brightness_pct)
                color_changed = max(dr, dg, db) >= COLOR_DELTA_THRESHOLD
                bright_changed = dbr >= BRIGHTNESS_DELTA_THRESHOLD
                too_soon = (now - self._last_send_ts.get(bulb_id, 0)) < MIN_SEND_INTERVAL
                if too_soon or (not color_changed and not bright_changed):
                    return
            self._last_sent[bulb_id] = {"rgb": rgb, "brightness": brightness_pct}
            self._last_send_ts[bulb_id] = now

        # Drop older pending updates for this same bulb -- latest wins.
        self._queue.put((bulb_id, rgb, brightness_pct))

    def restore(self) -> None:
        """Reissue power + color + brightness to whatever was saved by snapshot()."""
        if self._snapshot is None:
            return
        print("[bulbs] restoring previous state...")
        # Drain any pending queue items so restore commands aren't interleaved.
        with self._queue.mutex:
            self._queue.queue.clear()

        for bid_str, saved in self._snapshot.items():
            try:
                bid = int(bid_str)
            except (TypeError, ValueError):
                continue
            if bid == 1:  # strip handled by led_player itself
                continue
            ip = saved.get("ip")
            if not ip:
                continue
            self._push_hardware(
                ip=ip,
                on=bool(saved.get("on", False)),
                hex_color=saved.get("color", "#ffffff"),
                brightness=int(saved.get("brightness", 100)),
            )

    # -- worker + hardware -----------------------------------------------

    def _run(self) -> None:
        while not self._stop:
            try:
                item = self._queue.get(timeout=0.25)
            except Empty:
                continue
            if item is None:
                break
            bulb_id, rgb, brightness_pct = item
            bulb = self.bulbs.get(str(bulb_id))
            if not bulb:
                continue
            ip = bulb.get("ip")
            if not ip:
                continue
            try:
                # Turn the bulb on the first time we address it this session.
                if not self._power_on.get(bulb_id, False):
                    govee_power.send_power(device_ip=ip, on=True)
                    self._power_on[bulb_id] = True
                govee_color.send_color(device_ip=ip, rgb=rgb)
                govee_brightness.send_brightness(device_ip=ip, percent=brightness_pct)
            except Exception as e:
                print(f"[bulbs] send failed for id={bulb_id}: {e}")

    def _push_hardware(self, ip: str, on: bool, hex_color: str, brightness: int) -> None:
        if not GOVEE_AVAILABLE:
            return
        try:
            govee_power.send_power(device_ip=ip, on=on)
            if on:
                clean = hex_color.lstrip("#")
                r, g, b = int(clean[0:2], 16), int(clean[2:4], 16), int(clean[4:6], 16)
                if hex_color.lower() == "#ffffff":
                    govee_color.send_color(device_ip=ip, rgb=(r, g, b), color_temp_kelvin=9000)
                elif hex_color.lower() == "#ff680a":
                    govee_color.send_color(device_ip=ip, rgb=(r, g, b), color_temp_kelvin=2000)
                else:
                    govee_color.send_color(device_ip=ip, rgb=(r, g, b))
                govee_brightness.send_brightness(device_ip=ip, percent=brightness)
        except Exception as e:
            print(f"[bulbs] restore failed for ip={ip}: {e}")


# Convenience helper: derive (rgb_full, brightness_pct) from a raw painted color.
# When a pattern paints (100, 50, 25) onto a bulb, we treat the max channel as
# the intended brightness and rescale color to full amplitude so the bulb hits
# the intended hue rather than a dim brown.
def color_to_bulb(rgb: Tuple[int, int, int]) -> Tuple[Tuple[int, int, int], int]:
    r, g, b = rgb
    peak = max(r, g, b)
    if peak <= 2:
        return (0, 0, 0), 0
    scale = 255.0 / peak
    full = (int(r * scale), int(g * scale), int(b * scale))
    brightness_pct = int(round(peak / 255.0 * 100))
    brightness_pct = max(1, min(100, brightness_pct))
    return full, brightness_pct
