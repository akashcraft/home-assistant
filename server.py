import base64
import json
import socket as socket_lib
import sys
from pathlib import Path
from threading import Lock, RLock
from flask import Flask, jsonify, request
from flask_socketio import SocketIO

# --- 1. Setup paths and load Govee Library ---
PROJECT_ROOT = Path(__file__).resolve().parent
LOCAL_DEPS = PROJECT_ROOT / '.pydeps'

if LOCAL_DEPS.exists() and str(LOCAL_DEPS) not in sys.path:
    sys.path.insert(0, str(LOCAL_DEPS))

try:
    from govee.api.lan import power, brightness, color
    GOVEE_AVAILABLE = True
except ImportError:
    GOVEE_AVAILABLE = False


# --- 2. Flask & App Setup ---
app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='threading')

STATE_FILE = Path(__file__).with_name('bulb_state.json')
STATE_LOCK = Lock()

DEFAULT_BULBS = {
    "1": {"id": 1, "name": "Main Light", "ip": "192.168.2.30", "on": False, "brightness": 100, "color": "#ff0000"},
    "2": {"id": 2, "name": "Kitchen Bulb 1", "ip": "192.168.2.25", "on": False, "brightness": 100, "color": "#ff0000"},
    "3": {"id": 3, "name": "Kitchen Bulb 2", "ip": "192.168.2.26", "on": False, "brightness": 100, "color": "#ff0000"},
    "4": {"id": 4, "name": "Living Room Bulb", "ip": "192.168.2.28", "on": False, "brightness": 100, "color": "#ff0000"},
    "5": {"id": 5, "name": "Hallway Bulb", "ip": "192.168.2.29", "on": False, "brightness": 100, "color": "#ff0000"},
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


# --- 2b. Strip per-segment control (id=1 only) ----------------------------
# The 45-pixel strip at 192.168.2.30 speaks the "razer" UDP protocol on port 4003.
# See engine/led_player.py + engine/led_patterns.py for the source of truth on
# packet format and zone layout; the numbers here must stay in sync with them.
STRIP_IP = "192.168.2.30"
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
# Razer has no dedicated brightness command; we scale each RGB channel by
# strip_brightness / 100 before sending, which the eye reads as dimming.
strip_brightness = 100
strip_udp_sock = socket_lib.socket(socket_lib.AF_INET, socket_lib.SOCK_DGRAM)
strip_lock = RLock()
_strip_razer_enabled = False


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


def send_strip_frame(force_black=False):
    """Push a razer frame to the strip. force_black=True sends all-off pixels
    without mutating strip_zone_colors (so re-powering can restore state)."""
    global _strip_razer_enabled
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
        try:
            if not _strip_razer_enabled:
                strip_udp_sock.sendto(_razer_control_packet(True), (STRIP_IP, STRIP_PORT))
                _strip_razer_enabled = True
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


def strip_apply_power(on):
    """Turn the strip on/off via razer, never via govee. Govee power toggles
    knock the strip out of razer mode until a full reboot, which is what
    caused 'react shows on but hardware stays off' after an unselect-all."""
    if on:
        with strip_lock:
            has_any = any(strip_zone_colors[z] != "#000000" for z in STRIP_ZONES)
            if not has_any:
                # Nothing was lit -- default every zone to the bulb's saved
                # color so re-powering isn't a silent no-op.
                bulb1 = bulbs.get('1') or {}
                default_color = bulb1.get('color') or '#ffffff'
                for zone in STRIP_ZONES:
                    strip_zone_colors[zone] = default_color
        send_strip_frame()
    else:
        send_strip_frame(force_black=True)


# --- 3. Helper Functions ---
def update_hardware(bulb, action, value):
    """Send commands to the physical device. id=1 is the LED strip and speaks
    razer, not govee -- routed here to keep call sites uniform."""
    if bulb.get('id') == 1:
        global strip_brightness
        if action == "power":
            strip_apply_power(bool(value))
        elif action == "color":
            hex_color = str(value or "#000000")
            with strip_lock:
                lit = [z for z in STRIP_ZONES if strip_zone_colors[z] != "#000000"]
                targets = lit if lit else list(STRIP_ZONES.keys())
                for zone in targets:
                    strip_zone_colors[zone] = hex_color
            strip_apply_power(True)
        elif action == "brightness":
            with strip_lock:
                strip_brightness = max(0, min(100, int(value)))
            send_strip_frame()
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
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    return response


# --- 5. API Endpoints ---
@app.route('/api/bulbs', methods=['GET', 'OPTIONS'])
def get_bulbs():
    # Return a list of all bulb dictionaries
    return jsonify(list(bulbs.values()))

@app.route('/api/bulbs/<int:bulb_id>/toggle', methods=['POST', 'OPTIONS'])
def toggle_bulb(bulb_id):
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

    send_strip_frame()

    bulb = bulbs.get('1')
    if bulb is not None:
        bulb['color'] = color
        # The strip is "on" if any zone is lit; empty targets means blackout.
        bulb['on'] = any(c != '#000000' for c in strip_zone_colors.values())
        save_bulbs()
        socketio.emit('bulb_updated', bulb)

    return jsonify({
        'zones': STRIP_ZONE_ORDER,
        'colors': strip_zone_colors,
        'applied': targets,
    })


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'})


# --- 6. WebSockets ---
@socketio.on('connect')
def handle_connect():
    socketio.emit('bulbs_state', list(bulbs.values()))
    broadcast_strip_state()


if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=8080, debug=False)