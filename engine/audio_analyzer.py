"""
Loads the full song waveform once, then serves FFT bin levels for whatever
playback position the player asks for. This is "live" in the sense that the
analysis is computed fresh every frame based on current playback time --
it's just backed by an in-memory buffer instead of a live mic/loopback feed,
which avoids all the OS-specific loopback-device headaches.
"""

from __future__ import annotations

import numpy as np
import soundfile as sf


class AudioAnalyzer:
    def __init__(self, path: str, fft_window: int = 2048):
        data, samplerate = sf.read(path, always_2d=False, dtype="float32")
        if data.ndim > 1:
            data = data.mean(axis=1)  # downmix to mono
        self.data = data
        self.sr = samplerate
        self.window = fft_window
        self._hann = np.hanning(fft_window)

    def get_bin_levels(self, now_ms: float, n_bins: int, sensitivity: float = 30.0,
                        low_hz: float = 60.0, high_hz: float = 8000.0):
        """Return n_bins levels in [0, 1] for the window centered at now_ms."""
        center = int((now_ms / 1000.0) * self.sr)
        half = self.window // 2
        start = max(0, center - half)
        end = min(len(self.data), start + self.window)
        chunk = self.data[start:end]

        if len(chunk) < self.window:
            chunk = np.pad(chunk, (0, self.window - len(chunk)))

        windowed = chunk * self._hann
        fft = np.abs(np.fft.rfft(windowed))
        freqs = np.fft.rfftfreq(self.window, 1.0 / self.sr)

        nyquist = self.sr / 2.0
        edges = np.logspace(np.log10(low_hz), np.log10(min(high_hz, nyquist)), n_bins + 1)

        levels = []
        for i in range(n_bins):
            mask = (freqs >= edges[i]) & (freqs < edges[i + 1])
            mag = fft[mask].mean() if mask.any() else 0.0
            levels.append(float(min(1.0, mag / sensitivity)))
        return levels
