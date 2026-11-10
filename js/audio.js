// Audio engine: music playback off a decoded AudioBuffer, plus synthesised
// key/hit feedback so the port is playable without any skin samples.

export class AudioEngine {
    constructor() {
        this.ctx = null;
        this.masterGain = null;
        this.musicGain = null;
        this.sfxGain = null;
        this.source = null;
        this.beats = new Set();
        this.clicksEnabled = true;
    }

    ensure() {
        if (!this.ctx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) throw new Error('Web Audio is not available in this browser');

            this.ctx = new AudioContextClass();

            this.masterGain = this.ctx.createGain();
            this.masterGain.connect(this.ctx.destination);

            this.musicGain = this.ctx.createGain();
            this.musicGain.connect(this.masterGain);

            this.sfxGain = this.ctx.createGain();
            this.sfxGain.connect(this.masterGain);

            this.setVolume(70);
        }

        if (this.ctx.state === 'suspended')
            this.ctx.resume().catch(() => {});

        return this.ctx;
    }

    now() {
        return this.ctx ? this.ctx.currentTime : 0;
    }

    setVolume(percent) {
        if (!this.masterGain) return;
        const value = Math.max(0, Math.min(1, percent / 100));
        // A slight curve keeps the slider feeling natural.
        this.masterGain.gain.value = value * value;
        this.musicGain.gain.value = 0.85;
        this.sfxGain.gain.value = 0.5;
    }

    async decode(bytes) {
        const ctx = this.ensure();
        // decodeAudioData detaches the input buffer, so always hand it a copy.
        const copy = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
        return await ctx.decodeAudioData(copy.buffer);
    }

    scheduleMusic(buffer, offsetSeconds, when, rate = 1) {
        if (!this.ctx || !buffer) return;

        const ctx = this.ctx;
        const startAt = Math.max(when ?? ctx.currentTime, ctx.currentTime);

        if (offsetSeconds >= buffer.duration - 0.05)
            return;

        this.stopMusic();

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = rate;
        source.connect(this.musicGain);
        source.start(startAt, Math.max(0, offsetSeconds));
        this.source = source;
    }

    stopMusic() {
        if (!this.source) return;
        try {
            this.source.stop();
        } catch {
            // Already stopped.
        }
        this.source.disconnect();
        this.source = null;
    }

    suspend() {
        if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
    }

    resume() {
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    }

    // Short synthesised blip, used for key presses and note hits.
    blip({ frequency = 660, duration = 0.05, type = 'triangle', gain = 0.3 } = {}) {
        if (!this.ctx) return;

        const ctx = this.ctx;
        const time = ctx.currentTime;
        const oscillator = ctx.createOscillator();
        const envelope = ctx.createGain();

        oscillator.type = type;
        oscillator.frequency.setValueAtTime(frequency, time);
        oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.7, time + duration);

        envelope.gain.setValueAtTime(0, time);
        envelope.gain.linearRampToValueAtTime(gain, time + 0.004);
        envelope.gain.exponentialRampToValueAtTime(0.0001, time + duration);

        oscillator.connect(envelope);
        envelope.connect(this.sfxGain);
        oscillator.start(time);
        oscillator.stop(time + duration + 0.02);
    }

    // Metronome tick for offset calibration; can be scheduled ahead of time.
    beat(when, accent = false) {
        if (!this.ctx || !this.sfxGain) return;

        const ctx = this.ctx;
        const time = Math.max(when ?? ctx.currentTime, ctx.currentTime);
        const oscillator = ctx.createOscillator();
        const envelope = ctx.createGain();

        oscillator.type = 'square';
        oscillator.frequency.setValueAtTime(accent ? 1760 : 1320, time);

        envelope.gain.setValueAtTime(0.0001, time);
        envelope.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, time + 0.002);
        envelope.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);

        oscillator.onended = () => this.beats.delete(oscillator);
        this.beats.add(oscillator);

        oscillator.connect(envelope);
        envelope.connect(this.sfxGain);
        oscillator.start(time);
        oscillator.stop(time + 0.06);
    }

    // Cancels metronome ticks that were scheduled ahead of time.
    stopBeats() {
        for (const oscillator of this.beats) {
            try {
                oscillator.stop();
            } catch {
                // Already stopped.
            }
            try {
                oscillator.disconnect();
            } catch {
                // Already disconnected.
            }
        }
        this.beats.clear();
    }

    setClicksEnabled(enabled) {
        this.clicksEnabled = !!enabled;
    }

    // Short osu!-style click sound: a filtered noise burst with a tiny tonal tick.
    click() {
        if (!this.ctx || !this.clicksEnabled) return;

        const ctx = this.ctx;
        const time = ctx.currentTime;
        const duration = 0.03;
        const buffer = ctx.createBuffer(1, Math.max(1, Math.ceil(ctx.sampleRate * duration)), ctx.sampleRate);
        const data = buffer.getChannelData(0);

        for (let i = 0; i < data.length; i++) {
            const progress = i / data.length;
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - progress, 5);
        }

        const source = ctx.createBufferSource();
        source.buffer = buffer;

        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 2100;
        filter.Q.value = 0.8;

        const gain = ctx.createGain();
        gain.gain.value = 0.7;

        source.connect(filter);
        filter.connect(gain);
        gain.connect(this.sfxGain);
        source.start(time);
    }

    keyDown(column) {
        this.click();
    }

    hitNote(column) {
        this.blip({ frequency: 720 + column * 40, duration: 0.06, type: 'triangle', gain: 0.22 });
        this.blip({ frequency: 1440 + column * 60, duration: 0.03, type: 'sine', gain: 0.08 });
    }

    // Distinct low "thud" for misses: a descending tone plus a short noise
    // burst, louder and longer than the key click so it reads as a penalty.
    miss() {
        if (!this.ctx || !this.sfxGain) return;

        const ctx = this.ctx;
        const time = ctx.currentTime;

        const oscillator = ctx.createOscillator();
        const envelope = ctx.createGain();

        oscillator.type = 'sawtooth';
        oscillator.frequency.setValueAtTime(190, time);
        oscillator.frequency.exponentialRampToValueAtTime(58, time + 0.22);

        envelope.gain.setValueAtTime(0.0001, time);
        envelope.gain.exponentialRampToValueAtTime(0.32, time + 0.006);
        envelope.gain.exponentialRampToValueAtTime(0.0001, time + 0.26);

        oscillator.connect(envelope);
        envelope.connect(this.sfxGain);
        oscillator.start(time);
        oscillator.stop(time + 0.28);

        const duration = 0.12;
        const buffer = ctx.createBuffer(1, Math.max(1, Math.ceil(ctx.sampleRate * duration)), ctx.sampleRate);
        const data = buffer.getChannelData(0);

        for (let i = 0; i < data.length; i++) {
            const progress = i / data.length;
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - progress, 3);
        }

        const source = ctx.createBufferSource();
        source.buffer = buffer;

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 950;

        const noiseGain = ctx.createGain();
        noiseGain.gain.value = 0.5;

        source.connect(filter);
        filter.connect(noiseGain);
        noiseGain.connect(this.sfxGain);
        source.start(time);
    }
}
