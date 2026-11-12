// Menu song previews. Playback uses a plain <audio> element so a preview can
// never steal or stop the Web Audio graph that drives an actual play.

import { AUDIO_EXTENSIONS } from './beatmap.js';

const MIME_TYPES = {
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    flac: 'audio/flac',
    opus: 'audio/ogg',
};

const clamp01 = value => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

// The map's AudioFilename when present, otherwise the first audio file in the
// archive — the same fallback the game uses.
export function findAudioFile(zip, map) {
    if (!zip) return null;

    const named = map?.audioFile;
    if (named && zip.has(named)) return named;

    return zip.names.find(name =>
        AUDIO_EXTENSIONS.some(extension => name.toLowerCase().endsWith(`.${extension}`)),
    ) ?? null;
}

export class PreviewPlayer {
    constructor({ onState } = {}) {
        this.onState = onState ?? (() => {});
        this.entryId = null;
        this.loading = false;
        this.url = null;

        this.element = new Audio();
        this.element.preload = 'metadata';

        for (const event of ['timeupdate', 'durationchange', 'play', 'pause'])
            this.element.addEventListener(event, () => this.emit());

        this.element.addEventListener('ended', () => this.stop());
        this.element.addEventListener('error', () => {
            if (this.entryId) this.stop();
        });
    }

    get playing() {
        return !!this.entryId && !this.element.paused && !this.element.ended;
    }

    async play(entry, { volume } = {}) {
        if (!entry?.zip) {
            return { ok: false, reason: 'This chart has no .osz, so there is no song to preview.' };
        }

        const audioName = findAudioFile(entry.zip, entry.map);
        if (!audioName) return { ok: false, reason: 'No audio file was found inside this mapset.' };

        this.stop();

        const id = entry.id;
        this.entryId = id;
        this.loading = true;
        this.emit();

        try {
            const bytes = await entry.zip.readBytes(audioName);

            // Another map was selected while this one was being read.
            if (this.entryId !== id) return { ok: false, reason: '' };

            const extension = audioName.split('.').pop()?.toLowerCase();
            const type = MIME_TYPES[extension] ?? '';
            this.url = URL.createObjectURL(new Blob([bytes], type ? { type } : undefined));

            this.element.src = this.url;
            if (volume !== undefined) this.setVolume(volume);

            const startAt = Math.max(0, (entry.map.previewTime ?? 0) / 1000);
            this.element.addEventListener('loadedmetadata', () => {
                const duration = this.element.duration;
                if (startAt > 0 && Number.isFinite(duration) && startAt < duration - 1)
                    this.element.currentTime = startAt;
            }, { once: true });

            await this.element.play();

            this.loading = false;
            this.emit();
            return { ok: true };
        } catch (error) {
            this.loading = false;
            this.stop();
            return { ok: false, reason: 'This song could not be played by the browser.' };
        }
    }

    toggle() {
        if (!this.entryId) return;

        if (this.playing) {
            this.element.pause();
            return;
        }

        if (this.element.src) {
            this.element.play().catch(() => this.stop());
        }
    }

    seek(ratio) {
        if (!this.entryId) return;

        const duration = this.element.duration;
        if (!Number.isFinite(duration) || duration <= 0) return;

        this.element.currentTime = clamp01(ratio) * duration;
        this.emit();
    }

    setVolume(percent) {
        this.element.volume = clamp01(percent / 100);
    }

    stop() {
        if (!this.entryId && !this.url) return;

        this.entryId = null;
        this.loading = false;

        this.element.pause();
        this.element.removeAttribute('src');
        this.element.load();

        if (this.url) {
            URL.revokeObjectURL(this.url);
            this.url = null;
        }

        this.emit();
    }

    emit() {
        this.onState({
            entryId: this.entryId,
            playing: this.playing,
            loading: this.loading,
            currentTime: Number.isFinite(this.element.currentTime) ? this.element.currentTime : 0,
            duration: Number.isFinite(this.element.duration) ? this.element.duration : 0,
        });
    }
}
