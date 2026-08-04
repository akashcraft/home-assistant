import base64
import json
import platform
import re
import signal
import socket as socket_lib
import subprocess
import sys
import time
from io import BytesIO
from pathlib import Path
from threading import Event, Lock, RLock, Thread
from flask import Flask, jsonify, request, send_from_directory
from flask_socketio import SocketIO

# --- 1. Setup paths and load Govee Library ---
PROJECT_ROOT = Path(__file__).resolve().parent
LOCAL_DEPS = PROJECT_ROOT / '.pydeps'

if LOCAL_DEPS.exists() and str(LOCAL_DEPS) not in sys.path:
    sys.path.insert(0, str(LOCAL_DEPS))

try:
    from govee.api.lan import power as govee_power
    from govee.api.lan import brightness as govee_brightness
    from govee.api.lan import color as govee_color
    # Backwards-compat aliases for the rest of the file:
    power = govee_power
    brightness = govee_brightness
    color = govee_color
    GOVEE_AVAILABLE = True
except ImportError:
    GOVEE_AVAILABLE = False


# --- 2. Flask & App Setup ---
app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='threading')

STATE_FILE = Path(__file__).with_name('bulb_state.json')
STATE_LOCK = Lock()

DEFAULT_BULBS = {
    "1": {"id": 1, "name": "Main Light", "ip": "192.168.1.92", "on": False, "brightness": 100, "color": "#ff0000"},
    "2": {"id": 2, "name": "Kitchen Bulb 1", "ip": "192.168.1.116", "on": False, "brightness": 100, "color": "#ff0000"},
    "3": {"id": 3, "name": "Kitchen Bulb 2", "ip": "192.168.1.138", "on": False, "brightness": 100, "color": "#ff0000"},
    "4": {"id": 4, "name": "Living Room Bulb", "ip": "192.168.1.83", "on": False, "brightness": 100, "color": "#ff0000"},
    "5": {"id": 5, "name": "Hallway Bulb", "ip": "192.168.1.73", "on": False, "brightness": 100, "color": "#ff0000"},
}

def load_bulbs():
    """Load from JSON file, or use defaults if file is missing/broken."""
    if STATE_FILE.exists():
        try:
            with open(STATE_FILE, "r") as f:
                data = json.load(f)
                
                # FIX: If the old file saved it as a list, convert it to a dictionary
                if isinstance(data, list):
                    return {str(item["id"]): item for item in data if "id" in item}
                    
                return data
        except Exception:
            pass
    
    # We must use a deep copy so we don't accidentally modify the default template
    import copy
    return copy.deepcopy(DEFAULT_BULBS)

def save_bulbs():
    """Save the current dictionaries to the JSON file."""
    with STATE_LOCK:
        with open(STATE_FILE, "w") as f:
            json.dump(bulbs, f, indent=2)

# Load the data into memory when the script starts
bulbs = load_bulbs()

# --- 2a. Bulb reachability monitor ------------------------------------
BULB_CHECK_INTERVAL = 12  # seconds between full sweeps
BULB_PING_TIMEOUT = 2     # seconds waited per ping subprocess

# Monitor only runs while at least one browser tab is connected. Saves ~25
# subprocess-fork'd pings per minute when nobody's looking at the UI.
_active_clients = 0
_clients_lock = Lock()
_monitor_wakeup = Event()


def _ping_ip(ip):
    """Return True if the host answers a single ICMP echo. Uses the platform
    ping binary so we don't need raw-socket permissions."""
    if not ip:
        return False
    if platform.system().lower().startswith('win'):
        args = ['ping', '-n', '1', '-w', '1000', ip]
    else:
        args = ['ping', '-c', '1', '-W', '1000', ip]
    try:
        result = subprocess.run(args, capture_output=True, timeout=BULB_PING_TIMEOUT)
        return result.returncode == 0
    except Exception:
        return False


def _bulb_monitor_loop():
    """Every BULB_CHECK_INTERVAL seconds, ping each bulb. Flip `online` and
    force `on=false` when a bulb goes unreachable; broadcast on change.

    Pauses when no clients are connected (nobody would see the update
    anyway) and wakes immediately when the first client connects."""
    for b in bulbs.values():
        b.setdefault('online', True)
    while True:
        with _clients_lock:
            has_clients = _active_clients > 0
        if not has_clients:
            # Block until a client connects and pokes the event.
            _monitor_wakeup.wait()
            _monitor_wakeup.clear()
            continue
        try:
            for bid, bulb in list(bulbs.items()):
                ip = bulb.get('ip')
                if not ip:
                    continue
                online = _ping_ip(ip)
                prev = bool(bulb.get('online', True))
                if online == prev:
                    continue
                bulb['online'] = online
                if not online:
                    bulb['on'] = False
                save_bulbs()
                socketio.emit('bulb_updated', bulb)
                print(f"[monitor] bulb {bid} ({ip}) -> {'online' if online else 'offline'}")
        except Exception as e:
            print(f"[monitor] sweep error: {e}")
        time.sleep(BULB_CHECK_INTERVAL)


Thread(target=_bulb_monitor_loop, daemon=True).start()


# --- 2b. Strip per-segment control (id=1 only) ----------------------------
# The 45-pixel strip speaks the "razer" UDP protocol on port 4003.
# See engine/led_player.py + engine/led_patterns.py for the source of truth on
# packet format and zone layout; the numbers here must stay in sync with them.
STRIP_IP = "192.168.1.92"
STRIP_PORT = 4003
STRIP_PIXELS = 45
# Inclusive [start, end] pixel indices per named zone.
STRIP_ZONES = {
    "Table":   (0, 5),
    "Bed":     (6, 16),
    "Kitchen": (17, 24),
    "Main":    (25, 33),
    "Final":   (34, 44),
}
STRIP_ZONE_ORDER = list(STRIP_ZONES.keys())

# Last-known color per zone -- lets partial updates (e.g. "just Kitchen")
# preserve the other zones' colors instead of blacking them out.
strip_zone_colors = {name: "#000000" for name in STRIP_ZONES}
# Brightness is applied via govee LAN (hardware PWM). In pure razer mode we
# additionally scale RGB channels since razer has no brightness command.
strip_brightness = 100
strip_udp_sock = socket_lib.socket(socket_lib.AF_INET, socket_lib.SOCK_DGRAM)
strip_lock = RLock()
_strip_razer_enabled = False
# Hybrid: 'govee' handles power/whole-strip color/brightness, 'razer' takes
# over only for genuinely per-zone segment frames. Razer's black frame
# doesn't stick in hardware (the strip re-lights itself), so real off has
# to be govee power=False.
_strip_mode = 'govee'


def _razer_checksum(packet):
    value = 0
    for byte in packet:
        value ^= byte
    return value


def _razer_frame_packet(colors):
    packet = [0xBB, 0x00, 0xFA, 0xB0, 0x00, len(colors)]
    for r, g, b in colors:
        packet.extend([r, g, b])
    packet.append(_razer_checksum(packet))
    payload = base64.b64encode(bytes(packet)).decode("ascii")
    return json.dumps({"msg": {"cmd": "razer", "data": {"pt": payload}}}).encode()


def _razer_control_packet(enabled):
    packet = [0xBB, 0x00, 0x01, 0xB1,
              0x01 if enabled else 0x00,
              0x0A if enabled else 0x0B]
    payload = base64.b64encode(bytes(packet)).decode("ascii")
    return json.dumps({"msg": {"cmd": "razer", "data": {"pt": payload}}}).encode()


def _hex_to_rgb(hex_str):
    clean = (hex_str or "#000000").lstrip("#")
    if len(clean) != 6:
        return 0, 0, 0
    return int(clean[0:2], 16), int(clean[2:4], 16), int(clean[4:6], 16)


def _normalize_zone(name):
    for key in STRIP_ZONES:
        if key.lower() == (name or "").lower():
            return key
    return None


def _enter_razer_mode():
    global _strip_razer_enabled, _strip_mode
    with strip_lock:
        if not _strip_razer_enabled:
            try:
                strip_udp_sock.sendto(_razer_control_packet(True), (STRIP_IP, STRIP_PORT))
            except OSError as e:
                print(f"Strip razer-enable failed: {e}")
        _strip_razer_enabled = True
        _strip_mode = 'razer'


def _leave_razer_mode():
    """Return the strip to govee's stateful color/brightness so govee LAN
    commands render again."""
    global _strip_razer_enabled, _strip_mode
    with strip_lock:
        if _strip_razer_enabled:
            try:
                strip_udp_sock.sendto(_razer_control_packet(False), (STRIP_IP, STRIP_PORT))
            except OSError as e:
                print(f"Strip razer-disable failed: {e}")
        _strip_razer_enabled = False
        _strip_mode = 'govee'


def _strip_ip():
    return (bulbs.get('1') or {}).get('ip') or STRIP_IP


def _govee_send_power(on):
    if not GOVEE_AVAILABLE:
        return
    try:
        power.send_power(device_ip=_strip_ip(), on=bool(on))
    except Exception as e:
        print(f"Strip govee power failed: {e}")


def _govee_send_color(hex_color):
    if not GOVEE_AVAILABLE:
        return
    try:
        clean = (hex_color or '#ffffff').lstrip('#')
        r, g, b = int(clean[0:2], 16), int(clean[2:4], 16), int(clean[4:6], 16)
        ip = _strip_ip()
        low = (hex_color or '').lower()
        if low == '#ffffff':
            color.send_color(device_ip=ip, rgb=(r, g, b), color_temp_kelvin=9000)
        elif low == '#ff680a':
            color.send_color(device_ip=ip, rgb=(r, g, b), color_temp_kelvin=2000)
        else:
            color.send_color(device_ip=ip, rgb=(r, g, b))
    except Exception as e:
        print(f"Strip govee color failed: {e}")


def _govee_send_brightness(pct):
    if not GOVEE_AVAILABLE:
        return
    try:
        brightness.send_brightness(device_ip=_strip_ip(), percent=int(pct))
    except Exception as e:
        print(f"Strip govee brightness failed: {e}")


def send_strip_frame(force_black=False):
    """Push a razer frame to the strip. force_black=True is only used by the
    engine cleanup path; server routes normally take the govee power path
    since razer 'all-black' doesn't hold in hardware."""
    with strip_lock:
        if force_black:
            buffer = [(0, 0, 0)] * STRIP_PIXELS
        else:
            pct = max(0.0, min(1.0, strip_brightness / 100.0))
            scale = 0.5 + 0.5 * pct
            buffer = [(0, 0, 0)] * STRIP_PIXELS
            for zone, hex_color in strip_zone_colors.items():
                r, g, b = _hex_to_rgb(hex_color)
                r, g, b = int(r * scale), int(g * scale), int(b * scale)
                start, end = STRIP_ZONES[zone]
                for i in range(start, end + 1):
                    buffer[i] = (r, g, b)
        _enter_razer_mode()
        try:
            strip_udp_sock.sendto(_razer_frame_packet(buffer), (STRIP_IP, STRIP_PORT))
        except OSError as e:
            print(f"Strip UDP send failed: {e}")
    broadcast_strip_state()


def strip_active_zones():
    with strip_lock:
        return [z for z in STRIP_ZONE_ORDER if strip_zone_colors[z] != "#000000"]


def broadcast_strip_state():
    """Fan-out the current strip segment state so every connected client
    (all open drawers, tiles, etc.) can sync their checkboxes."""
    bulb = bulbs.get('1') or {}
    payload = {
        'zones': STRIP_ZONE_ORDER,
        'colors': dict(strip_zone_colors),
        'active': strip_active_zones(),
        'on': bool(bulb.get('on', False)),
        'brightness': strip_brightness,
    }
    socketio.emit('strip_updated', payload)


# --- 2c. Music library + playback --------------------------------------
MUSIC_DIR = PROJECT_ROOT / "music"
MUSIC_DIR.mkdir(exist_ok=True)
ENGINE_DIR = PROJECT_ROOT / "engine"
SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._ -]+")
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".flac", ".ogg"}


class MusicPlayback:
    """Currently-running music process, if any. Only one plays at a time,
    controlled by exactly one browser -- the owner. Other browsers can
    watch the state but cannot start/stop while this one holds control."""
    process = None  # subprocess.Popen
    basename = None
    linked = False
    owner = None  # opaque client id string sent by the browser
    lock = Lock()


music_state = MusicPlayback()


def _safe_basename(name: str) -> str:
    stem = Path(name).stem
    cleaned = SAFE_NAME_RE.sub("", stem).strip()
    return cleaned or "track"


def _track_paths(basename: str):
    return {
        "audio": None,  # resolved from disk since ext varies
        "art": MUSIC_DIR / f"{basename}.png",
        "json": MUSIC_DIR / f"{basename}.json",
    }


def _find_audio_file(basename: str):
    for ext in AUDIO_EXTS:
        p = MUSIC_DIR / f"{basename}{ext}"
        if p.exists():
            return p
    return None


def _music_broadcast():
    with music_state.lock:
        payload = {
            "playing": music_state.basename,
            "linked": music_state.linked,
            "owner": music_state.owner,
        }
    socketio.emit("music_updated", payload)


def _music_kill_locked():
    """Terminate the current playback subprocess. Caller must hold the lock.
    Sends SIGINT (not SIGTERM) so led_player.py's `except KeyboardInterrupt`
    branch runs its finally block -- that's where the strip is blanked and
    the bulbs are restored to their pre-song state."""
    global _strip_razer_enabled, _strip_mode
    proc = music_state.process
    if proc is not None:
        try:
            proc.send_signal(signal.SIGINT)
            try:
                # led_player restores 4 bulbs sequentially; give it room.
                proc.wait(timeout=6.0)
            except subprocess.TimeoutExpired:
                proc.terminate()
                try:
                    proc.wait(timeout=2.0)
                except subprocess.TimeoutExpired:
                    proc.kill()
        except Exception as e:
            print(f"[music] stop error: {e}")
    music_state.process = None
    music_state.basename = None
    music_state.linked = False
    music_state.owner = None
    # led_player sends razer control(False) in its finally block, so the
    # strip is back in govee mode. Sync our flags so subsequent user actions
    # take the govee path immediately without stale razer state.
    _strip_razer_enabled = False
    _strip_mode = 'govee'


def _music_stop():
    with music_state.lock:
        was_playing = music_state.process is not None
        _music_kill_locked()
    if was_playing:
        _music_broadcast()


def _stop_music_if_linked(reason: str = "user action"):
    """Called from every bulb/strip mutation. When music is linked to lights,
    a user tweaking a light means they want the routine, not the show -- so
    kill playback immediately."""
    with music_state.lock:
        if not music_state.linked or music_state.process is None:
            return
        print(f"[music] stopping linked playback: {reason}")
        _music_kill_locked()
    _music_broadcast()


def _music_watchdog(proc, basename: str):
    """Wait for the subprocess to end and clean up state so the UI flips
    back to the Play icon when the song finishes naturally."""
    global _strip_razer_enabled, _strip_mode
    proc.wait()
    with music_state.lock:
        if music_state.process is proc and music_state.basename == basename:
            music_state.process = None
            music_state.basename = None
            music_state.linked = False
            music_state.owner = None
            emit_after = True
        else:
            emit_after = False
    # Same razer-flag sync as _music_kill_locked -- covers natural song end.
    _strip_razer_enabled = False
    _strip_mode = 'govee'
    if emit_after:
        _music_broadcast()


def _list_music_tracks():
    tracks = []
    seen = set()
    for path in sorted(MUSIC_DIR.iterdir()):
        if path.suffix.lower() not in AUDIO_EXTS:
            continue
        base = path.stem
        if base in seen:
            continue
        seen.add(base)
        tracks.append({
            "basename": base,
            "filename": path.name,
            "has_art": (MUSIC_DIR / f"{base}.png").exists(),
            "has_json": (MUSIC_DIR / f"{base}.json").exists(),
        })
    return tracks


def _extract_album_art(audio_path: Path, out_png: Path) -> bool:
    """Pull embedded artwork from the audio file and write it as PNG.
    Returns True on success. Never raises -- missing art isn't fatal."""
    try:
        from mutagen import File as MutagenFile
        from PIL import Image
    except ImportError as e:
        print(f"[music] album art skipped, missing dep: {e}")
        return False

    try:
        audio = MutagenFile(str(audio_path))
        if audio is None:
            return False

        data = None
        # ID3 (mp3)
        tags = getattr(audio, "tags", None)
        if tags:
            for key in list(tags.keys()):
                if key.startswith("APIC"):
                    data = tags[key].data
                    break
        # MP4 / M4A
        if data is None and hasattr(audio, "get"):
            covr = audio.get("covr")
            if covr:
                data = bytes(covr[0])
        # FLAC / OGG
        if data is None and getattr(audio, "pictures", None):
            data = audio.pictures[0].data

        if not data:
            return False

        img = Image.open(BytesIO(data))
        # Normalize to RGB PNG so the browser is guaranteed to render it.
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGB")
        img.save(str(out_png), "PNG")
        return True
    except Exception as e:
        print(f"[music] album art failed: {e}")
        return False


def _generate_timeline(audio_path: Path, include_bulbs: bool, segments_mode: str) -> None:
    """Invoke engine/generate_timeline.py as a subprocess so librosa's heavy
    import isn't paid in the Flask process. Blocks until the JSON is written."""
    cmd = [
        sys.executable,
        str(ENGINE_DIR / "generate_timeline.py"),
        str(audio_path),
        "--segments", segments_mode,
        "--bulbs" if include_bulbs else "--no-bulbs",
    ]
    print(f"[music] generating timeline: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"generate_timeline failed (exit {result.returncode}): "
            f"{result.stderr.strip() or result.stdout.strip()}"
        )


def strip_apply_power(on):
    """Power the strip on/off via govee. Razer 'all-black' doesn't stick in
    hardware -- the strip re-lights itself after a moment -- so real off has
    to go through the govee LAN power command."""
    _leave_razer_mode()
    _govee_send_power(bool(on))
    if on:
        # Re-apply the saved color so the strip comes back looking the same
        # instead of whatever govee-default it had before.
        bulb1 = bulbs.get('1') or {}
        saved_color = bulb1.get('color') or '#ffffff'
        _govee_send_color(saved_color)
        _govee_send_brightness(strip_brightness)
        with strip_lock:
            # State: whole strip = saved color.
            for zone in STRIP_ZONES:
                strip_zone_colors[zone] = saved_color
    else:
        with strip_lock:
            for zone in STRIP_ZONES:
                strip_zone_colors[zone] = '#000000'
    broadcast_strip_state()


# --- 3. Helper Functions ---
def update_hardware(bulb, action, value):
    """Send commands to the physical device. id=1 is the LED strip; we drive
    it primarily via govee LAN and only fall through to razer for genuine
    per-zone segment work (see /api/bulbs/1/segments)."""
    if bulb.get('id') == 1:
        global strip_brightness
        if action == "power":
            strip_apply_power(bool(value))
        elif action == "color":
            hex_color = str(value or "#ffffff")
            _leave_razer_mode()
            _govee_send_power(True)
            _govee_send_color(hex_color)
            _govee_send_brightness(strip_brightness)
            with strip_lock:
                for zone in STRIP_ZONES:
                    strip_zone_colors[zone] = hex_color
            broadcast_strip_state()
        elif action == "brightness":
            with strip_lock:
                strip_brightness = max(0, min(100, int(value)))
            _govee_send_brightness(strip_brightness)
            # If we happen to be in razer mode, re-render so the scaled RGB
            # reflects the new brightness immediately.
            if _strip_mode == 'razer':
                send_strip_frame()
            else:
                broadcast_strip_state()
        return

    if not GOVEE_AVAILABLE:
        print("Hardware ignored: Govee library not found.")
        return

    ip = bulb["ip"]

    if action == "power":
        power.send_power(device_ip=ip, on=value)

    elif action == "brightness":
        brightness.send_brightness(device_ip=ip, percent=value)

    elif action == "color":
        clean_hex = value.lstrip('#')
        r = int(clean_hex[0:2], 16)
        g = int(clean_hex[2:4], 16)
        b = int(clean_hex[4:6], 16)

        if value.lower() == "#ffffff":
          color.send_color(device_ip=ip, rgb=(r, g, b), color_temp_kelvin=9000)
        elif value.lower() == "#ff680a":
          color.send_color(device_ip=ip, rgb=(r, g, b), color_temp_kelvin=2000)
        else:
          color.send_color(device_ip=ip, rgb=(r, g, b))


# --- 4. Server Middleware (CORS) ---
@app.before_request
def handle_preflight():
    if request.method == 'OPTIONS':
        return '', 204

@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS'
    return response


# --- 5. API Endpoints ---
@app.route('/api/bulbs', methods=['GET', 'OPTIONS'])
def get_bulbs():
    # Return a list of all bulb dictionaries
    return jsonify(list(bulbs.values()))

@app.route('/api/bulbs/<int:bulb_id>/toggle', methods=['POST', 'OPTIONS'])
def toggle_bulb(bulb_id):
    _stop_music_if_linked(f"bulb {bulb_id} toggled")
    bulb = bulbs.get(str(bulb_id))
    if not bulb:
        return jsonify({'error': 'Bulb not found'}), 404

    # Flip the on/off switch
    bulb['on'] = not bulb['on']
    save_bulbs()
    
    update_hardware(bulb, action="power", value=bulb['on'])
    socketio.emit('bulb_updated', bulb)
    
    return jsonify(bulb)

@app.route('/api/bulbs/<int:bulb_id>/power', methods=['POST', 'OPTIONS'])
def set_bulb_power(bulb_id):
    _stop_music_if_linked(f"bulb {bulb_id} power")
    payload = request.get_json(silent=True) or {}

    bulb = bulbs.get(str(bulb_id))
    if not bulb:
        return jsonify({'error': 'Bulb not found'}), 404

    bulb['on'] = bool(payload.get('on', False))
    save_bulbs()
    
    update_hardware(bulb, action="power", value=bulb['on'])
    socketio.emit('bulb_updated', bulb)
    
    return jsonify(bulb)

@app.route('/api/bulbs/<int:bulb_id>/brightness', methods=['POST', 'OPTIONS'])
def set_bulb_brightness(bulb_id):
    _stop_music_if_linked(f"bulb {bulb_id} brightness")
    payload = request.get_json(silent=True) or {}

    bulb = bulbs.get(str(bulb_id))
    if not bulb:
        return jsonify({'error': 'Bulb not found'}), 404

    bulb['brightness'] = int(payload.get('brightness', 100))
    bulb['on'] = True
    save_bulbs()
    
    update_hardware(bulb, action="brightness", value=bulb['brightness'])
    socketio.emit('bulb_updated', bulb)
    
    return jsonify(bulb)

@app.route('/api/bulbs/<int:bulb_id>/color', methods=['POST', 'OPTIONS'])
def set_bulb_color(bulb_id):
    _stop_music_if_linked(f"bulb {bulb_id} color")
    payload = request.get_json(silent=True) or {}

    bulb = bulbs.get(str(bulb_id))
    if not bulb:
        return jsonify({'error': 'Bulb not found'}), 404

    bulb['color'] = payload.get('color', '#ffffff')
    bulb['on'] = True
    save_bulbs()
    
    update_hardware(bulb, action="color", value=bulb['color'])
    socketio.emit('bulb_updated', bulb)
    
    return jsonify(bulb)

@app.route('/api/bulbs/1/segments', methods=['GET', 'POST', 'OPTIONS'])
def strip_segments():
    """GET  -> current per-zone color map + zone order.
    POST -> body { segments: ["All"] | ["Table", "Bed", ...], color: "#rrggbb" }
            updates just the named zones (or every zone if "All" is present)
            and pushes one razer frame to the strip."""
    if request.method == 'GET':
        return jsonify({'zones': STRIP_ZONE_ORDER, 'colors': strip_zone_colors})

    _stop_music_if_linked("strip segments changed")
    payload = request.get_json(silent=True) or {}
    raw_segments = payload.get('segments') or []
    color = payload.get('color', '#ffffff')
    exclusive = bool(payload.get('exclusive', False))
    if not isinstance(raw_segments, list):
        return jsonify({'error': 'segments must be an array'}), 400

    apply_all = any((s or '').lower() == 'all' for s in raw_segments)
    if apply_all:
        targets = list(STRIP_ZONES.keys())
    else:
        targets = [z for z in (_normalize_zone(s) for s in raw_segments) if z]

    with strip_lock:
        if exclusive:
            # Selected zones get the color; everything else is turned off.
            for zone in STRIP_ZONES:
                strip_zone_colors[zone] = color if zone in targets else '#000000'
        else:
            for zone in targets:
                strip_zone_colors[zone] = color

        non_black = {c for c in strip_zone_colors.values() if c != '#000000'}
        all_lit_same = (
            len(non_black) == 1
            and all(strip_zone_colors[z] != '#000000' for z in STRIP_ZONES)
        )
        nothing_lit = (len(non_black) == 0)

    # Route: nothing lit -> govee power off (razer black wouldn't stick).
    # Whole strip one color -> govee (proper hardware brightness/color).
    # Genuine mix -> razer frame.
    if nothing_lit:
        _leave_razer_mode()
        _govee_send_power(False)
        broadcast_strip_state()
    elif all_lit_same:
        uniform = next(iter(non_black))
        _leave_razer_mode()
        _govee_send_power(True)
        _govee_send_color(uniform)
        _govee_send_brightness(strip_brightness)
        broadcast_strip_state()
    else:
        send_strip_frame()

    bulb = bulbs.get('1')
    if bulb is not None:
        bulb['color'] = color
        bulb['on'] = not nothing_lit
        save_bulbs()
        socketio.emit('bulb_updated', bulb)

    return jsonify({
        'zones': STRIP_ZONE_ORDER,
        'colors': strip_zone_colors,
        'applied': targets,
    })


@app.route('/api/music', methods=['GET', 'OPTIONS'])
def list_music():
    return jsonify(_list_music_tracks())


@app.route('/api/music/upload', methods=['POST', 'OPTIONS'])
def upload_music():
    file = request.files.get('audio')
    if file is None or not file.filename:
        return jsonify({'error': 'no audio file provided'}), 400

    include_bulbs = str(request.form.get('include_bulbs', 'true')).lower() == 'true'
    segments_mode = str(request.form.get('segments_mode', 'mix')).lower()
    if segments_mode not in ('all', 'zones', 'mix'):
        segments_mode = 'mix'

    ext = Path(file.filename).suffix.lower()
    if ext not in AUDIO_EXTS:
        return jsonify({'error': f'unsupported extension {ext}'}), 400

    base = _safe_basename(file.filename)
    # Don't clobber an existing track: append -N to disambiguate.
    candidate = base
    counter = 2
    while _find_audio_file(candidate) is not None:
        candidate = f"{base}-{counter}"
        counter += 1
    base = candidate

    audio_path = MUSIC_DIR / f"{base}{ext}"
    file.save(str(audio_path))

    art_ok = _extract_album_art(audio_path, MUSIC_DIR / f"{base}.png")
    if not art_ok:
        # Not a fatal error -- the tile falls back to a placeholder -- but
        # the UI wants a distinct signal so it can window.alert() the user.
        pass

    try:
        _generate_timeline(audio_path, include_bulbs, segments_mode)
    except Exception as e:
        # Roll back audio + art so a broken track doesn't clutter the list.
        for p in (audio_path, MUSIC_DIR / f"{base}.png"):
            try:
                if p.exists():
                    p.unlink()
            except Exception:
                pass
        return jsonify({'error': f'timeline generation failed: {e}'}), 500

    socketio.emit('music_library_updated', _list_music_tracks())
    return jsonify({
        'basename': base,
        'filename': audio_path.name,
        'has_art': art_ok,
        'has_json': (MUSIC_DIR / f"{base}.json").exists(),
    })


@app.route('/api/music/<basename>/art', methods=['GET', 'OPTIONS'])
def get_music_art(basename):
    safe = _safe_basename(basename)
    art = MUSIC_DIR / f"{safe}.png"
    if not art.exists():
        return jsonify({'error': 'no art'}), 404
    return send_from_directory(str(MUSIC_DIR), f"{safe}.png")


@app.route('/api/music/<basename>/stream', methods=['GET', 'OPTIONS'])
def stream_music(basename):
    """Serve the raw audio file so browsers can play it via <audio>.
    Flask's send_from_directory handles HTTP Range requests when the client
    asks for them, so seeking works out of the box."""
    safe = _safe_basename(basename)
    audio = _find_audio_file(safe)
    if audio is None:
        return jsonify({'error': 'track not found'}), 404
    return send_from_directory(str(MUSIC_DIR), audio.name, conditional=True)


@app.route('/api/music/<basename>/play', methods=['POST', 'OPTIONS'])
def play_music(basename):
    """Browser-driven playback: exactly one browser plays audio at a time,
    identified by an opaque `owner` id it sends in the body. If another
    browser is currently the owner, this request is refused with 409.

    When 'link_to_lights' is set we also spawn engine/led_renderer.py (no
    audio, wall-clock synced) to drive the strip + bulbs. Manual CLI
    testing via engine/led_player.py or engine/play_music.py is unaffected."""
    safe = _safe_basename(basename)
    audio = _find_audio_file(safe)
    if audio is None:
        return jsonify({'error': 'track not found'}), 404

    payload = request.get_json(silent=True) or {}
    link = bool(payload.get('link_to_lights', False))
    owner = str(payload.get('owner') or '').strip()
    if not owner:
        return jsonify({'error': 'missing owner id'}), 400

    json_path = MUSIC_DIR / f"{safe}.json"
    if link and not json_path.exists():
        return jsonify({'error': 'no timeline JSON for this track'}), 400

    proc = None
    with music_state.lock:
        # Reject if a different browser owns the current playback.
        if music_state.owner is not None and music_state.owner != owner:
            return jsonify({
                'error': 'music is playing on another device',
                'playing': music_state.basename,
                'owner': music_state.owner,
            }), 409
        _music_kill_locked()
        if link:
            try:
                proc = subprocess.Popen(
                    [sys.executable, str(ENGINE_DIR / "led_renderer.py"),
                     str(audio), str(json_path)],
                    cwd=str(ENGINE_DIR),
                )
            except Exception as e:
                return jsonify({'error': f'failed to start renderer: {e}'}), 500
        music_state.process = proc
        music_state.basename = safe
        music_state.linked = link
        music_state.owner = owner

    if proc is not None:
        Thread(target=_music_watchdog, args=(proc, safe), daemon=True).start()

    _music_broadcast()
    return jsonify({
        'playing': safe,
        'linked': link,
        'owner': owner,
        'stream_url': f"/api/music/{safe}/stream",
    })


@app.route('/api/music/stop', methods=['POST', 'OPTIONS'])
def stop_music_endpoint():
    payload = request.get_json(silent=True) or {}
    owner = str(payload.get('owner') or '').strip()
    with music_state.lock:
        if music_state.owner is not None and music_state.owner != owner:
            return jsonify({
                'error': 'not the current owner',
                'owner': music_state.owner,
            }), 403
    _music_stop()
    return jsonify({'playing': None})


@app.route('/api/music/<basename>', methods=['DELETE', 'OPTIONS'])
def delete_music(basename):
    safe = _safe_basename(basename)
    with music_state.lock:
        if music_state.basename == safe and music_state.process is not None:
            _music_kill_locked()
            was_playing = True
        else:
            was_playing = False
    if was_playing:
        _music_broadcast()

    removed = []
    audio = _find_audio_file(safe)
    if audio is not None:
        try:
            audio.unlink()
            removed.append(audio.name)
        except Exception as e:
            return jsonify({'error': f'failed to delete audio: {e}'}), 500
    for suffix in ('.png', '.json'):
        p = MUSIC_DIR / f"{safe}{suffix}"
        if p.exists():
            try:
                p.unlink()
                removed.append(p.name)
            except Exception as e:
                print(f"[music] delete side-file failed: {e}")

    socketio.emit('music_library_updated', _list_music_tracks())
    return jsonify({'removed': removed})


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'})


# --- 6. WebSockets ---
@socketio.on('connect')
def handle_connect():
    global _active_clients
    with _clients_lock:
        _active_clients += 1
        first = _active_clients == 1
    # Wake the monitor immediately so a freshly opened UI gets accurate
    # online/offline state in one sweep instead of waiting up to 12s.
    if first:
        _monitor_wakeup.set()
    socketio.emit('bulbs_state', list(bulbs.values()))
    broadcast_strip_state()
    socketio.emit('music_library_updated', _list_music_tracks())
    _music_broadcast()


@socketio.on('disconnect')
def handle_disconnect():
    global _active_clients
    with _clients_lock:
        _active_clients = max(0, _active_clients - 1)


if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=8080, debug=False, allow_unsafe_werkzeug=True)
