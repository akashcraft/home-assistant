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
- Visual effect editor: a drag-and-drop timeline for hand-tuning a track's generated JSON
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

### Frontend
```
cd front-end
npm ci
npm run dev
```
For a production deploy, `npm run build` and serve the `dist/` folder from any static host - or point `send_from_directory` in `server.py` at it and serve from one process.

> [!IMPORTANT]
> Update `API_BASE_URL` in `front-end/src/config.ts` to your server's IP. It can also be overridden per run with the `VITE_API_BASE_URL` environment variable.

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

Gaps between events send a true black frame, and razer mode is re-asserted every `RAZER_KEEPALIVE_SEC` (2s) while the player runs. Without the keepalive a dark stretch would let razer mode lapse and the strip would re-light itself in its previous govee colour mid-song - black frames on their own don't seem to count as activity. If that ever comes back, `IDLE_LEVEL` in `led_player.py` raises the floor for "off" pixels from 0 to 1, which keeps every frame non-zero at a level that is nearly invisible.

Uploads from the Library drawer save the audio + extracted `.png` album art + generated `.json` timeline into `/music/`. Delete removes all three.

### Effect Editor
The auto-generated timeline is a first draft. The `{ }` button on a track row in the Library drawer opens an editor for it in a new tab (`#/effects/<track>`):

- **Left** - the effect palette. Drag an effect onto a lane to add it, or tap it and then tap a lane.
- **Right** - settings for the selected event: pattern, target device, start/end, segments, colour and that pattern's own parameters. Save overwrites `<track>.json`; Cancel warns if there are unsaved changes before closing the tab.
- **Bottom** - one lane per device, taken from `bulb_state.json`. Drag events to move them (vertically too, to retarget a device), drag their edges to resize, `Del` to remove, `⌘Z`/`⌘⇧Z` to undo/redo. Click anywhere on the ruler or empty lane space to drop the playhead there; a dashed ghost head tracks the cursor with the time it would jump to, and `←`/`→` nudge it 100 ms at a time (`⇧` for 1 s), pausing playback so it stays parked where you left it. **Snap 100 ms** in the timeline header rounds every move, resize and drop to a tenth of a second (off by default). Overlapping events are outlined in red, since the player only renders the last match.
  - **Selecting several**: drag across empty lane space to rubber-band a selection, or `⌥`-drag when the lane is too packed to find a gap. `⇧`-click adds or removes one, `⌘A` takes the lot, `Esc` clears. `Del` removes the whole selection in one undo step, and dragging any member moves the set together.

**Sync Lights** (toggle in the timeline header) runs the timeline on the real hardware while the song plays in the browser: `engine/led_preview.py` renders the same patterns as `led_player.py` against a wall clock instead of an audio clock. It previews what's on screen, unsaved edits included, so nothing has to be written to disk first. Playback starts only once the renderer reports ready, so the two stay in step; pausing, closing the tab, or touching a light in the main UI stops it, and the bulbs are restored exactly as they are after a normal light show. Seeking mid-playback relaunches the renderer at the new offset, so the lights take a moment to catch up.

Segments accept anything `resolve_segments()` in `engine/led_patterns.py` understands: `all`, zone names, single pixels, `2-7` ranges, or a comma-separated mix like `Table, 20-24, Final`. **Pixel indices are 0-based** (`0-44` on the 45-pixel strip), matching the JSON and the engine. Saving a track that is currently playing does not affect the running player - it loaded its copy at launch.

## Who can use this?
You are free to download and edit the source code files however you like.
Should you wish to publish this in your project or socials, please provide appropriate credits.

You can add this as your reference if you like:

Source Code: https://github.com/akashcraft/home-assistant<br>
Website: [akashcraft.ca](https://akashcraft.ca)
