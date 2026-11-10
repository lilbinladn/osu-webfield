// Built-in demo content: a 4K mania chart plus a synthesised 160 BPM track,
// so the port is playable before any .osz is loaded.

const BPM = 160;
const BEAT = 60000 / BPM;
const BARS = 24;
const START_BEAT = 16;

export function buildDemoChart() {
    const hits = [];
    const busy = new Array(4).fill(-Infinity);
    const start = START_BEAT * BEAT;

    const put = (time, column, holdMs = 0) => {
        const rounded = Math.round(time);
        if (rounded < busy[column] + 30) return;

        if (holdMs > 0) {
            hits.push({ time: rounded, column, endTime: Math.round(rounded + holdMs) });
            busy[column] = rounded + holdMs + 90;
        } else {
            hits.push({ time: rounded, column });
            busy[column] = rounded + 70;
        }
    };

    for (let bar = 0; bar < BARS; bar++) {
        const barTime = start + bar * 4 * BEAT;
        const section = Math.floor(bar / 4);
        const fill = bar % 4 === 3;

        if (bar % 8 === 0) {
            put(barTime, 0); put(barTime, 1); put(barTime, 2); put(barTime, 3);
        } else if (bar % 2 === 0) {
            put(barTime, 0); put(barTime, 3);
        } else {
            put(barTime, section % 2 === 0 ? 1 : 2);
        }

        put(barTime + BEAT, section % 2 === 0 ? 1 : 2);
        put(barTime + 2 * BEAT, section % 2 === 0 ? 2 : 1);
        put(barTime + 3 * BEAT, 1);
        if (bar % 2 === 1) put(barTime + 3 * BEAT, 2);

        const stream = section % 2 === 0 ? [0, 1, 2, 3] : [3, 2, 1, 0];
        for (let step = 1; step < 8; step += 2) {
            const time = barTime + step * BEAT / 2;
            put(time, stream[step % 4]);
        }

        if (fill) {
            const holdTime = barTime + 2 * BEAT;
            put(holdTime, 1, 2 * BEAT);
            put(holdTime, 3, 1.5 * BEAT);
        }
    }

    hits.sort((a, b) => a.time - b.time || a.column - b.column);

    const lines = hits.map(hit => {
        const x = Math.floor((hit.column + 0.5) * 512 / 4);
        if (hit.endTime) return `${x},192,${hit.time},128,0,${hit.endTime}:0:0:0:0:`;
        return `${x},192,${hit.time},1,0,0:0:0:0:`;
    });

    // One slow SV change mid-song so the port's scroll-velocity handling is visible.
    const svTime = Math.round(start + 8 * 4 * BEAT);
    const svBack = Math.round(start + 16 * 4 * BEAT);

    const duration = Math.ceil((start + BARS * 4 * BEAT) / 1000) + 2;

    return `osu file format v14

[General]
AudioFilename: demo.mp3
Mode: 3
PreviewTime: ${Math.round(start)}

[Metadata]
Title:Web Port Demo
TitleUnicode:Web Port Demo
Artist:osu!mania
ArtistUnicode:osu!mania
Creator:Codebuff
Version:4K Insane

[Difficulty]
HPDrainRate:7
CircleSize:4
OverallDifficulty:8
ApproachRate:5
SliderMultiplier:1.4
SliderTickRate:1

[Events]
//Background and Video events

[TimingPoints]
0,${BEAT},4,2,100,100,1,0
${svTime},-62.5,4,2,100,100,0,0
${svBack},-100,4,2,100,100,0,0

[HitObjects]
${lines.join('\n')}
`;
}

export const DEMO_LENGTH_MS = (START_BEAT + BARS * 4) * BEAT + 3000;

// A small offline synth: four-on-the-floor kick, backbeat snare, hats,
// a bassline and a pad, all scheduled from the same 160 BPM grid as the chart.
export function createDemoMusic(ctx) {
    const sampleRate = ctx.sampleRate;
    const length = Math.ceil(DEMO_LENGTH_MS / 1000 * sampleRate);
    const buffer = ctx.createBuffer(2, length, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    let seed = 1337;
    const noise = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff * 2 - 1;
    };

    const write = (startSeconds, durationSeconds, generator, gain = 1, pan = 0) => {
        const startSample = Math.floor(startSeconds * sampleRate);
        const sampleCount = Math.floor(durationSeconds * sampleRate);
        const leftGain = gain * Math.sqrt(Math.max(0, 0.5 - pan * 0.5)) * Math.SQRT2;
        const rightGain = gain * Math.sqrt(Math.max(0, 0.5 + pan * 0.5)) * Math.SQRT2;

        for (let i = 0; i < sampleCount; i++) {
            const index = startSample + i;
            if (index < 0 || index >= length) continue;
            const value = generator(i / sampleRate);
            left[index] += value * leftGain;
            right[index] += value * rightGain;
        }
    };

    const kick = (time, gain = 0.95) => {
        write(time, 0.34, t => Math.sin(2 * Math.PI * (44 * t + 130 * 0.055 * (1 - Math.exp(-t / 0.05)))) * Math.exp(-t * 11), gain);
    };

    const snare = (time, gain = 0.32) => {
        let previous = 0;
        write(time, 0.24, t => {
            const n = noise();
            const high = n - previous * 0.6;
            previous = n;
            return (high * 0.85 + Math.sin(2 * Math.PI * 185 * t) * 0.35) * Math.exp(-t * 20);
        }, gain);
    };

    const hat = (time, gain = 0.1) => {
        let previous = 0;
        write(time, 0.07, t => {
            const n = noise();
            const high = n - previous;
            previous = n;
            return high * Math.exp(-t * 70);
        }, gain, 0.25);
    };

    const bass = (time, frequency, durationSeconds, gain = 0.34) => {
        write(time, durationSeconds, t => {
            const envelope = Math.min(1, t / 0.005) * Math.exp(-t * 5.5);
            return (Math.sin(2 * Math.PI * frequency * t) * 0.75
                + Math.sin(4 * Math.PI * frequency * t) * 0.18) * envelope;
        }, gain);
    };

    const pad = (time, frequencies, durationSeconds, gain = 0.1) => {
        write(time, durationSeconds, t => {
            const attack = Math.min(1, t / 0.45);
            const release = Math.min(1, Math.max(0, (durationSeconds - t) / 0.5));
            let value = 0;
            for (const frequency of frequencies)
                value += Math.sin(2 * Math.PI * frequency * t + Math.sin(t * 0.7));
            return value / frequencies.length * attack * release;
        }, gain);
    };

    // Am - F - C - G, two bars each.
    const progression = [
        { root: 110.0, chord: [220.0, 261.63, 329.63] },   // Am
        { root: 87.31, chord: [174.61, 220.0, 261.63] },   // F
        { root: 130.81, chord: [261.63, 329.63, 392.0] },  // C
        { root: 98.0, chord: [196.0, 246.94, 293.66] },    // G
    ];

    const totalBars = Math.ceil(DEMO_LENGTH_MS / (4 * BEAT));
    const startSeconds = START_BEAT * BEAT / 1000;

    for (let bar = 0; bar < totalBars; bar++) {
        const barStart = bar * 4 * BEAT / 1000;
        const chordIndex = Math.floor(bar / 2) % progression.length;
        const chord = progression[chordIndex];
        const inChart = barStart + 4 * BEAT / 1000 >= startSeconds - 0.001;

        for (let beat = 0; beat < 4; beat++) {
            const time = barStart + beat * BEAT / 1000;
            if (inChart) kick(time);

            if (beat === 1 || beat === 3) snare(time);

            hat(time + BEAT / 2000, 0.09);
            hat(time + BEAT / 1000 * 1.5, 0.05);

            if (inChart) {
                bass(time, chord.root, BEAT / 1000 * 0.6);
                if (beat % 2 === 0)
                    bass(time + BEAT / 2000, chord.root * 2, BEAT / 1000 * 0.35, 0.16);
            }
        }

        if (inChart) {
            pad(barStart, chord.chord, 4 * BEAT / 1000 * 0.9, 0.11);
        }
    }

    // Soft clip so stacked voices never crackle.
    for (let i = 0; i < length; i++) {
        left[i] = Math.tanh(left[i] * 1.1) * 0.85;
        right[i] = Math.tanh(right[i] * 1.1) * 0.85;
    }

    return buffer;
}
