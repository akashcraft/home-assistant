# Home Lights
Web-based control hub for an all local smart lighting, no internet needed. A 45-pixel Govee LED strip and four Govee smart bulbs on the LAN - with routines, per-segment control, and a music-reactive engine that syncs the whole room to a song. I plan to add a robot vacuum cleaner in future.

<img width=600px src="https://github.com/user-attachments/assets/66cb0c32-305a-4b47-9049-984a042995a8">

## Features
- Dark Mode and Phone-friendly
- One-tap Routines (Kitchen, Red, Orange, Maximum, Sleep)
- Per-bulb Power, Colour, and Brightness with live socket updates
- LED strip per-segment control
- Music library with album art extraction and auto-generated LED timelines from `librosa` beat analysis
- Optional "Enable Light Show" playback mode that drives the whole room in time with the track
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

### Backend
Python 3.11+ recommended. Create a virtual environment and install the requirements:
```
git clone https://github.com/akashcraft/home-assistant.git
cd home-assistant
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```
Run the server:
```
python server.py
```
It listens on `0.0.0.0:8080` (HTTP + Socket.IO).

> [!NOTE]
> `govee-python` adds a 0.5 s "verification" delay after every LAN command, which makes routines feel sluggish and can starve the LED-sync loop. In the installed package, set `DEFAULT_VERIFICATION_DELAY = 0` (and `DEFAULT_VERIFICATION_RETRY_DELAY = 0` where present) in each of `power.py`, `brightness.py`, and `color.py`:
> ```
> .venv/lib/python3.12/site-packages/govee/api/lan/power.py
> .venv/lib/python3.12/site-packages/govee/api/lan/brightness.py
> .venv/lib/python3.12/site-packages/govee/api/lan/color.py
> ```

### Frontend
```
cd front-end
npm ci
npm run dev
```
For a production deploy, `npm run build` and serve the `dist/` folder from any static host - or point `send_from_directory` in `server.py` at it and serve from one process.

> [!IMPORTANT]
> Update `API_BASE_URL` in `front-end/src/App.tsx` and `front-end/src/Drawer.tsx` to your server's IP.

## Changing Bulb Defaults
Bulb state lives in `bulb_state.json` at the project root. First launch creates it from the defaults baked into `server.py`. Edit the file (or the `DEFAULT_BULBS` dict in `server.py`) to change the IP list, names, or starting colours. Restart `server.py` to reload.

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

The 45-pixel strip zones are defined in `server.py` (`STRIP_ZONES`) and mirrored in `engine/led_patterns.py`. Both must stay in sync if you change pixel ranges. The code is reverse engineered thanks to https://github.com/nicolasdeory/govee-realtime-control

## Music Engine
`engine/generate_timeline.py` analyses a song (tempo, beats, RMS, HPSS) and writes a JSON timeline of LED events. `engine/led_player.py` plays the mp3 and drives the strip + bulbs in sync at ~30 FPS. `engine/play_music.py` is a small `pygame.mixer` wrapper used when the light show is disabled.

Uploads from the Library drawer save the audio + extracted `.png` album art + generated `.json` timeline into `/music/`. Delete removes all three.

## Who can use this?
You are free to download and edit the source code files however you like.
Should you wish to publish this in your project or socials, please provide appropriate credits.

You can add this as your reference if you like:

Source Code: https://github.com/akashcraft/home-assistant<br>
Website: [akashcraft.ca](https://akashcraft.ca)
