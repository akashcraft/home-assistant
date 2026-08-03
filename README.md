# Home Lights
Web-based control hub for a hybrid lighting setup - a 45-pixel Govee LED strip and four Govee smart bulbs on the LAN - with routines, per-segment control, and a music-reactive engine that syncs the whole room to a song.

<img width=600px src="https://github.com/user-attachments/assets/66cb0c32-305a-4b47-9049-984a042995a8">

## Features
- Dark Mode React frontend, phone-friendly
- One-tap Routines (Kitchen, Red, Orange, Maximum, Sleep)
- Per-bulb Power, Colour, and Brightness with live socket updates
- LED strip per-segment control (Table / Bed / Kitchen / Main / Final)
- Hybrid strip driver - Govee LAN for whole-strip / power / brightness, Razer protocol only for mixed-zone frames
- Music library with album art extraction and auto-generated LED timelines from `librosa` beat analysis
- Optional "Enable Light Show" playback mode that drives the whole room in time with the track
- Any manual bulb or routine change during a light show immediately stops the music
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
- 1 x Govee RGBIC LED strip at `192.168.2.30` (the main light, exposed as id `1`)
- 2 x Kitchen Govee bulbs at `192.168.2.25` and `.26` (ids `2`, `3`)
- 1 x Living Room Govee bulb at `192.168.2.28` (id `4`)
- 1 x Hallway Govee bulb at `192.168.2.29` (id `5`)

All devices need LAN control enabled in the Govee Home app.

## Installation

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

### Frontend
```
cd front-end
npm ci
npm run dev
```
For a production deploy, `npm run build` and serve the `dist/` folder from any static host - or point `send_from_directory` in `server.py` at it and serve from one process.

Update `API_BASE_URL` in `front-end/src/App.tsx` and `front-end/src/Drawer.tsx` to your server's IP if it isn't `192.168.2.27:8080`.

### System dependencies (Debian / Armbian / DietPi)
```
sudo apt install python3-venv ffmpeg libsndfile1
```
`ffmpeg` and `libsndfile1` are pulled in by `librosa` for audio decoding.

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

The 45-pixel strip zones are defined in `server.py` (`STRIP_ZONES`) and mirrored in `engine/led_patterns.py`. Both must stay in sync if you change pixel ranges.

## Music Engine
`engine/generate_timeline.py` analyses a song (tempo, beats, RMS, HPSS) and writes a JSON timeline of LED events. `engine/led_player.py` plays the mp3 and drives the strip + bulbs in sync at ~30 FPS. `engine/play_music.py` is a small `pygame.mixer` wrapper used when the light show is disabled.

Uploads from the Library drawer save the audio + extracted `.png` album art + generated `.json` timeline into `/music/`. Delete removes all three.

## Who can use this?
You are free to download and edit the source code files however you like.
Should you wish to publish this in your project or socials, please provide appropriate credits.

You can add this as your reference if you like:

Source Code: https://github.com/akashcraft/home-assistant<br>
Website: [akashcraft.ca](https://akashcraft.ca)
