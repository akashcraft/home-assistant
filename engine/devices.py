"""
Reads the device list the server manages in bulb_state.json.

Everything in the engine used to hardcode the strip's IP and a fixed bulb id
range (2..5). Devices are now added, re-addressed and removed from the UI, so
the engine has to ask rather than assume. Device id 1 is always the LED strip;
every other id is a colour bulb.

Kept dependency-free and side-effect-free so both led_player.py (running as a
subprocess mid-song) and generate_timeline.py can import it cheaply.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional

PROJECT_ROOT = Path(__file__).resolve().parent.parent
STATE_FILE = PROJECT_ROOT / "bulb_state.json"

STRIP_DEVICE_ID = 1
# Only used when bulb_state.json is missing or unreadable -- the server writes
# that file on first launch, so in practice this never applies.
STRIP_IP_FALLBACK = "192.168.2.30"
STRIP_PORT = 4003
STRIP_PIXELS = 45


def load_devices() -> Dict[str, dict]:
    """Raw {id_str: device} map, or {} if the state file isn't usable."""
    if not STATE_FILE.exists():
        return {}
    try:
        with open(STATE_FILE, "r") as f:
            data = json.load(f)
    except Exception as e:
        print(f"[devices] could not read {STATE_FILE.name}: {e}")
        return {}
    if isinstance(data, list):  # tolerate the legacy list shape
        return {str(item["id"]): item for item in data if "id" in item}
    return data if isinstance(data, dict) else {}


def _device_ids(devices: Optional[Dict[str, dict]] = None) -> List[int]:
    devices = load_devices() if devices is None else devices
    ids = []
    for key, device in devices.items():
        try:
            ids.append(int(device.get("id", key)))
        except (TypeError, ValueError):
            continue
    return sorted(ids)


def strip_ip(devices: Optional[Dict[str, dict]] = None) -> str:
    devices = load_devices() if devices is None else devices
    entry = devices.get(str(STRIP_DEVICE_ID)) or {}
    return entry.get("ip") or STRIP_IP_FALLBACK


def bulb_ids(devices: Optional[Dict[str, dict]] = None) -> List[int]:
    """Every configured device except the strip, in id order."""
    return [i for i in _device_ids(devices) if i != STRIP_DEVICE_ID]
