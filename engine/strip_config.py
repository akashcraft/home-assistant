"""Shared network + strip constants used by led_player, led_renderer, and
anything else in engine/ that talks to the razer-protocol LED strip.

Keep the IP in sync with server.py's STRIP_IP and bulb id 1 in bulb_state.json.
"""

STRIP_IP = "192.168.1.92"
STRIP_PORT = 4003
STRIP_PIXELS = 45
STRIP_FPS = 30
