# Home Lights
Web-based control hub for an all local smart lighting, no internet needed. A 45-pixel Govee LED strip and four Govee smart bulbs on the LAN - with routines, per-segment control, and a music-reactive engine that syncs the whole room to a song. I plan to add a robot vacuum cleaner in future.

<img width=600px src="https://github.com/user-attachments/assets/66cb0c32-305a-4b47-9049-984a042995a8">

## Features
- Dark Mode and Phone-friendly
- One-tap Routines (Kitchen, Red, Orange, Maximum, Sleep)
- Per-bulb Power, Colour, and Brightness with live socket updates
- Devices drawer to add, rename, re-address or remove lights by IP, with no restart
- LED strip per-segment control
- Music library with album art extraction, plus on-demand LED timelines from onset-peak analysis; generated shows borrow the handcrafted timelines' sparse gestures, recurring color motifs, selective zone routing, layered beat accents, isolated-vocal pulses, and upbeat/drop bulb accents
- Optional "Enable Light Show" playback mode that drives the whole room in time with the track
- Visual effect editor: a drag-and-drop timeline for generating and hand-tuning a track's JSON
- Bulb offline detection with automatic UI lockout, only pinging while a client is connected
- Persistent library preferences via `localStorage`

## Screenshots

### Music Library Drawer
<img width=600px src="https://github.com/user-attachments/assets/7d36660a-ead6-4668-a238-2a81f421e7e3">

### Main Light Settings Drawer
<img width=600px src="https://github.com/user-attachments/assets/c3d31101-a60c-4e76-970a-e5d965059378">

### The LEDs on the Ceiling
<img width=600px src="https://github.com/user-attachments/assets/f48e0dd5-63e4-4cf6-bbc9-9bb2b6786e78">

## Hardware
Runs headless on an Orange Pi Zero 3 (or anything similar). The frontend can be opened from any device on the same network.

<img width=300px src="http://www.orangepi.org/img/zero3/0627-zero3%20(9).png">

Devices used:
- 1 x Orange Pi Zero 3
- 1 x [Govee RGBIC LED H618F strip](https://www.amazon.ca/dp/B09VBZC2CX?ref=ppx_yo2ov_dt_b_fed_asin_title&th=1)
- 4 x [Govee H6008 bulbs](https://www.amazon.ca/dp/B09B7NQT2K?ref=ppx_yo2ov_dt_b_fed_asin_title&th=1)
- 2 x [Mechanical Timer Plugs](https://www.amazon.ca/dp/B01LPT0IQA?ref=ppx_yo2ov_dt_b_fed_asin_title&th=1)
- 2 x Samsung Galaxy Tab A8 for Front-End Control

All devices need LAN control enabled in the Govee Home app.

## Installation

### System dependencies (Debian)
```
sudo apt update && sudo apt-get install git python3-venv ffmpeg libsndfile1
```

### Setup
Python 3.11+ recommended, plus Node.js for the frontend build. Create a virtual environment and install the requirements:
```
git clone https://github.com/akashcraft/home-assistant.git
cd home-assistant
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```
`.venv` is one of the interpreters `start.sh` looks for, so once this is done there's nothing to activate by hand.

### Running it
```
./start.sh
```
That's the whole thing. It builds the frontend if it's out of date, then serves the UI **and** the API from one python process on port 8080 - no second terminal, no vite. Open `http://localhost:8080`, or `http://<server-ip>:8080` from a phone or tablet.

#### From Finder
Double-click **Home Lights.command**. It runs the same launcher in a Terminal window, then opens the UI in your browser once the server answers. The window stays up so you can watch the log; Ctrl+C (or closing it) stops the server.

#### On the Orange Pi (start at boot)
`deploy/home-lights.service` is a systemd unit, so the Pi serves the UI from boot without anyone logging in:
```
sudo cp deploy/home-lights.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now home-lights
```
Edit `User` and the paths in the file first. It runs with `--no-build` on the assumption you build on your laptop and copy `front-end/dist` across - the Pi can do it, just slowly.

| | |
|---|---|
| `./start.sh` | build if stale, then run |
| `./start.sh --rebuild` | force a fresh frontend build |
| `./start.sh --no-build` | skip the build (fastest start) |
| `PORT=9000 ./start.sh` | serve on a different port |

The launcher picks the first python that has the dependencies: `$PYTHON`, then `.venv/`, then a `homeassistant-led` conda env, then `python3`. The music engine runs as subprocesses of that same interpreter, so it's the one that needs `librosa` and `pygame`.

Because the built UI is served by Flask, it talks to whichever host served it - there's no address baked into the bundle and nothing to edit when the server's IP changes.

### Frontend development
```
cd front-end
npm ci
npm run dev
```
Vite's dev server has hot reload, but runs on its own port, so it needs to know where the API lives. Set that in `DEV_API_BASE_URL` in `front-end/src/config.ts`, or per run with `VITE_API_BASE_URL=http://192.168.2.27:8080 npm run dev`. Production builds ignore both.

## Managing Devices
The slider icon beside the clock opens the **Devices** drawer - add a bulb by IP, rename or re-address an existing one, or remove it. Changes are written to `bulb_state.json` immediately and pushed to every connected client; no restart needed.

Device id 1 is always the LED strip. It carries the per-segment razer logic the bulbs don't have, so its address is editable but it can't be deleted. Every other id is an ordinary colour bulb, and you can have as many (or as few) as you like.

`bulb_state.json` is the single source of truth for the whole project - the server, the music engine and the effect editor all read it, so no IP or device id is hardcoded anywhere. The `DEFAULT_BULBS` dict in `server.py` only seeds the file on first launch. Editing the file by hand still works if you'd rather; restart `server.py` to reload.

Example entry:
```json
"4": {
  "id": 4,
  "name": "Living Room Bulb",
  "ip": "192.168.2.28",
  "on": false,
  "brightness": 100,
  "color": "#ff680a"
}
```

New bulbs need LAN control enabled in the Govee Home app, and are best given a reserved address in your router so they don't move.

The 45-pixel strip zones are defined in `server.py` (`STRIP_ZONES`) and mirrored in `engine/led_patterns.py`. Both must stay in sync if you change pixel ranges. The code is reverse engineered thanks to https://github.com/nicolasdeory/govee-realtime-control

## Who can use this?
You are free to download and edit the source code files however you like.
Should you wish to publish this in your project or socials, please provide appropriate credits.

You can add this as your reference if you like:

Source Code: https://github.com/akashcraft/home-assistant<br>
Website: [akashcraft.ca](https://akashcraft.ca)
