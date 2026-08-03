import json
import sys
from pathlib import Path
from threading import Lock
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


# --- 3. Helper Functions ---
def update_hardware(bulb, action, value):
    """Send commands to the physical Govee bulb."""
    if not GOVEE_AVAILABLE:
        print("Hardware ignored: Govee library not found.")
        return

    ip = bulb["ip"]
    
    if action == "power":
        power.send_power(device_ip=ip, on=value)
        
    elif action == "brightness":
        brightness.send_brightness(device_ip=ip, percent=value)
        
    elif action == "color":
        # Convert hex (like "#ff0000") to RGB (255, 0, 0) in plain English
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

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'})


# --- 6. WebSockets ---
@socketio.on('connect')
def handle_connect():
    socketio.emit('bulbs_state', list(bulbs.values()))


if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=8080, debug=False)