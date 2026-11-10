// Parser for osu!mania beatmaps (.osu, file format v3-v14).
// Mirrors the relevant parts of osu.Game.Rulesets.Mania:
//   * key count from Difficulty.CircleSize
//   * column from floor(x * keyCount / 512)
//   * hit windows from ManiaHitWindows (OD difficulty ranges)
//   * scroll velocity from inherited timing points, integrated over time

export const MANIA_MODE = 3;

export const AUDIO_EXTENSIONS = ['mp3', 'ogg', 'wav', 'm4a', 'aac', 'flac', 'opus'];

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp)$/i;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// Hit window ranges, taken verbatim from ManiaHitWindows.cs (ms).
const HIT_WINDOW_RANGES = {
    perfect: [22.4, 19.4, 13.9],
    great: [64, 49, 34],
    good: [97, 82, 67],
    ok: [127, 112, 97],
    meh: [151, 136, 121],
    miss: [188, 173, 158],
};

// Equivalent of IBeatmapDifficultyInfo.DifficultyRange: interpolate the
// difficulty (0-10) across the [min, mid, max] range.
function difficultyRange(difficulty, [min, mid, max]) {
    if (difficulty > 5)
        return mid + (max - mid) * (difficulty - 5) / 5;
    if (difficulty < 5)
        return mid - (mid - min) * (5 - difficulty) / 5;
    return mid;
}

// Mirrors ManiaHitWindows.updateWindows: every range is scaled by
// speedMultiplier / difficultyMultiplier before the stable rounding.
export function computeHitWindows(overallDifficulty, { speedMultiplier = 1, difficultyMultiplier = 1 } = {}) {
    const totalMultiplier = speedMultiplier / difficultyMultiplier;
    const windows = {};

    for (const [key, range] of Object.entries(HIT_WINDOW_RANGES))
        windows[key] = Math.floor(difficultyRange(overallDifficulty, range) * totalMultiplier) + 0.5;

    return windows;
}

function parseKeyValues(lines = []) {
    const result = {};
    for (const line of lines) {
        const index = line.indexOf(':');
        if (index < 0) continue;
        result[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    }
    return result;
}

function toNumber(value, fallback = 0) {
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? number : fallback;
}

function splitCsv(line) {
    const parts = [];
    const pattern = /"([^"]*)"|([^,]+)/g;
    let match;
    while ((match = pattern.exec(line)) !== null)
        parts.push(match[1] !== undefined ? match[1] : match[2]);
    return parts.map(part => part.trim());
}

function parseSections(text) {
    const sections = {};
    let current = null;

    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('//') || line.startsWith('osu file format'))
            continue;

        const header = line.match(/^\[(.+)\]$/);
        if (header) {
            current = header[1].toLowerCase();
            sections[current] = sections[current] ?? [];
            continue;
        }

        if (current) sections[current].push(line);
    }

    return sections;
}

function parseTimingPoints(lines = []) {
    const points = [];

    for (const line of lines) {
        const parts = line.split(',');
        if (parts.length < 2) continue;

        const time = toNumber(parts[0], NaN);
        const beatLength = toNumber(parts[1], NaN);
        if (!Number.isFinite(time) || !Number.isFinite(beatLength)) continue;

        points.push({
            time,
            beatLength,
            meter: toNumber(parts[2], 4),
            volume: toNumber(parts[5], 100),
            // Older files omit the flag; positive beat lengths are uninherited.
            uninherited: parts.length > 6 ? parts[6].trim() !== '0' : beatLength > 0,
            kiai: parts.length > 7 && (Number.parseInt(parts[7], 10) & 1) === 1,
        });
    }

    return points.sort((a, b) => a.time - b.time);
}

function parseHitObjects(lines = [], keyCount) {
    const objects = [];

    for (const line of lines) {
        const parts = line.split(',');
        if (parts.length < 5) continue;

        const x = toNumber(parts[0], NaN);
        const time = toNumber(parts[2], NaN);
        const type = Number.parseInt(parts[3], 10);
        if (!Number.isFinite(x) || !Number.isFinite(time) || !Number.isFinite(type))
            continue;

        // Mania notes/holds only. Spinners (type 8) are not valid in mania.
        const isHold = (type & 128) !== 0;
        const isNote = (type & 1) !== 0;
        if (!isHold && !isNote) continue;

        let endTime = null;
        if (isHold) {
            const end = Number.parseFloat(String(parts[5] ?? '').split(':')[0]);
            if (Number.isFinite(end)) endTime = Math.max(end, time + 1);
        }

        objects.push({
            column: clamp(Math.floor(x * keyCount / 512), 0, keyCount - 1),
            time,
            endTime,
        });
    }

    return objects.sort((a, b) => a.time - b.time || a.column - b.column);
}

function parseBackgroundFile(lines = []) {
    for (const line of lines) {
        const parts = splitCsv(line);
        if (!parts.length) continue;

        const type = parts[0].toLowerCase();
        if (type !== '0' && type !== 'background' && type !== 'video') continue;

        const file = parts[2];
        if (!file || IMAGE_EXTENSIONS.test(file) === false) continue;

        return file;
    }
    return null;
}

// Builds a time -> scroll distance mapping so that note positions respect
// inherited (SV) timing points. Distance is measured in "ms at 1.0x SV".
export function createScroller(timingPoints) {
    const sections = [];

    for (const point of timingPoints) {
        let sv = 1;

        if (!point.uninherited) {
            // Inherited points encode velocity as a negative beat length.
            if (point.beatLength >= 0) continue;
            sv = clamp(-100 / point.beatLength, 0.01, 10);
        }

        const previous = sections[sections.length - 1];
        if (previous && previous.time === point.time) {
            previous.sv = sv;
            continue;
        }

        sections.push({ time: point.time, sv });
    }

    if (!sections.length) sections.push({ time: 0, sv: 1 });
    if (sections[0].time > 0) sections.unshift({ time: 0, sv: 1 });

    let distance = 0;
    sections[0].distance = 0;

    for (let i = 1; i < sections.length; i++) {
        distance += (sections[i].time - sections[i - 1].time) * sections[i - 1].sv;
        sections[i].distance = distance;
    }

    function distanceAt(time) {
        let low = 0;
        let high = sections.length - 1;
        let index = 0;

        while (low <= high) {
            const mid = (low + high) >> 1;
            if (sections[mid].time <= time) {
                index = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        const section = sections[index];
        return section.distance + (time - section.time) * section.sv;
    }

    return { sections, distanceAt };
}

export function parseOsu(rawText, fileName = 'beatmap.osu') {
    const text = String(rawText).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const sections = parseSections(text);

    const general = parseKeyValues(sections.general);
    const metadata = parseKeyValues(sections.metadata);
    const difficulty = parseKeyValues(sections.difficulty);

    const mode = Number.parseInt(general.mode ?? '0', 10);
    const isMania = mode === MANIA_MODE;
    const keyCount = clamp(Math.round(toNumber(difficulty.circlesize, 4)), 1, 18);
    const od = clamp(toNumber(difficulty.overalldifficulty, 5), 0, 10);
    const hp = clamp(toNumber(difficulty.hpdrainrate, 5), 0, 10);

    const timingPoints = parseTimingPoints(sections.timingpoints);
    const objects = isMania ? parseHitObjects(sections.hitobjects, keyCount) : [];

    const firstTiming = timingPoints.find(point => point.uninherited && point.beatLength > 0);
    const bpm = firstTiming ? 60000 / firstTiming.beatLength : 0;

    const hitObjects = objects.map(object => ({
        ...object,
        isHold: object.endTime !== null,
    }));

    const firstTime = hitObjects.length ? hitObjects[0].time : 0;
    const lastTime = hitObjects.reduce(
        (max, object) => Math.max(max, object.endTime ?? object.time),
        firstTime,
    );

    const scroller = createScroller(timingPoints);

    return {
        fileName,
        isMania,
        mode,
        keyCount,
        overallDifficulty: od,
        drainRate: hp,
        bpm,
        timingPoints,
        hits: hitObjects,
        scroll: scroller,
        distanceAt: scroller.distanceAt,
        hitWindow: computeHitWindows(od),
        firstTime,
        lastTime,
        duration: lastTime,
        noteCount: hitObjects.length,
        holdCount: hitObjects.filter(object => object.isHold).length,
        maxJudgements: hitObjects.reduce((total, object) => total + (object.isHold ? 2 : 1), 0),
        audioFile: general.audiofilename || null,
        backgroundFile: parseBackgroundFile(sections.events),
        title: metadata.title || fileName.replace(/\.osu$/i, ''),
        titleUnicode: metadata.titleunicode || metadata.title || '',
        artist: metadata.artist || 'Unknown artist',
        artistUnicode: metadata.artistunicode || metadata.artist || '',
        creator: metadata.creator || 'Unknown creator',
        version: metadata.version || 'Normal',
        source: metadata.source || '',
        tags: metadata.tags || '',
    };
}

// ---------------------------------------------------------------- osu!standard
// Parses mode 0 maps: circles, sliders (linear / bezier / catmull / perfect
// circle) and spinners. Slider paths are sampled and trimmed to their file
// pixel length so the ball can be positioned at any time during the slide.

const SLIDER_CURVE_POINTS = 32;

function bezierAt(points, t) {
    let working = points;

    while (working.length > 1) {
        const next = [];

        for (let i = 0; i < working.length - 1; i++) {
            next.push({
                x: working[i].x + (working[i + 1].x - working[i].x) * t,
                y: working[i].y + (working[i + 1].y - working[i].y) * t,
            });
        }

        working = next;
    }

    return { x: working[0].x, y: working[0].y };
}

function sampleBezierSegment(points) {
    return Array.from({ length: SLIDER_CURVE_POINTS + 1 }, (_, i) => bezierAt(points, i / SLIDER_CURVE_POINTS));
}

function sampleBezier(points) {
    if (points.length < 2) return points.slice();

    // Consecutive duplicate points are red anchors in osu! and split the curve.
    const segments = [];
    let current = [points[0]];

    for (let i = 1; i < points.length; i++) {
        const previous = points[i - 1];
        const duplicate = Math.abs(points[i].x - previous.x) < 0.01 && Math.abs(points[i].y - previous.y) < 0.01;

        if (duplicate && current.length >= 2) {
            segments.push(current);
            current = [points[i]];
        } else {
            current.push(points[i]);
        }
    }

    if (current.length >= 2) segments.push(current);
    if (!segments.length) return points.slice(0, 2);

    if (segments.length === 1) return sampleBezierSegment(points);

    const vertices = [];

    for (const segment of segments) {
        const samples = segment.length >= 2 ? sampleBezierSegment(segment) : segment.slice();
        vertices.push(...(vertices.length ? samples.slice(1) : samples));
    }

    return vertices;
}

function sampleCatmull(points) {
    if (points.length < 3) return points.slice();

    const vertices = [];

    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(points.length - 1, i + 2)];

        for (let step = 0; step <= 16; step++) {
            const t = step / 16;
            const t2 = t * t;
            const t3 = t2 * t;

            vertices.push({
                x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
                y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
            });
        }
    }

    return vertices;
}

function samplePerfectCircle(points) {
    if (points.length < 3) return points.slice();

    const [a, b, c] = points;
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));

    if (Math.abs(d) < 0.001) return [a, c];

    const aSq = a.x * a.x + a.y * a.y;
    const bSq = b.x * b.x + b.y * b.y;
    const cSq = c.x * c.x + c.y * c.y;

    const centre = {
        x: (aSq * (b.y - c.y) + bSq * (c.y - a.y) + cSq * (a.y - b.y)) / d,
        y: (aSq * (c.x - b.x) + bSq * (a.x - c.x) + cSq * (b.x - a.x)) / d,
    };

    const radius = Math.hypot(a.x - centre.x, a.y - centre.y);
    const normalize = angle => {
        let value = angle;
        while (value < 0) value += Math.PI * 2;
        while (value >= Math.PI * 2) value -= Math.PI * 2;
        return value;
    };

    const start = Math.atan2(a.y - centre.y, a.x - centre.x);
    const mid = Math.atan2(b.y - centre.y, b.x - centre.x);
    const end = Math.atan2(c.y - centre.y, c.x - centre.x);

    const clockwiseSweep = normalize(end - start);
    const clockwiseMid = normalize(mid - start);
    const anticlockwiseSweep = normalize(start - end);
    const anticlockwiseMid = normalize(start - mid);

    const clockwise = clockwiseMid <= clockwiseSweep && clockwiseSweep > 0;
    const sweep = clockwise ? clockwiseSweep : (anticlockwiseSweep > 0 ? anticlockwiseSweep : Math.PI * 2);
    const direction = clockwise ? 1 : -1;

    const vertices = [];

    for (let i = 0; i <= SLIDER_CURVE_POINTS * 2; i++) {
        const angle = start + direction * sweep * (i / (SLIDER_CURVE_POINTS * 2));
        vertices.push({ x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius });
    }

    return vertices;
}

function sampleCurve(type, points) {
    if (points.length < 2) return points.slice();
    if (points.length === 2) return points.slice();

    switch (type) {
        case 'L':
            return points.slice();
        case 'C':
            return sampleCatmull(points);
        case 'P':
            return samplePerfectCircle(points);
        default:
            return sampleBezier(points);
    }
}

function fitSliderPath(vertices, expectedLength) {
    const points = vertices.filter((point, index, array) => index === 0
        || Math.hypot(point.x - array[index - 1].x, point.y - array[index - 1].y) > 0.01);

    if (!points.length) return { points: [{ x: 0, y: 0 }], cumulative: [0], length: 0 };
    if (points.length === 1) points.push({ ...points[0] });

    let cumulative = [0];

    for (let i = 1; i < points.length; i++)
        cumulative.push(cumulative[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));

    const total = cumulative[cumulative.length - 1];

    if (expectedLength > 0 && total > expectedLength) {
        let index = cumulative.findIndex(length => length >= expectedLength);
        if (index <= 0) index = 1;

        const previousLength = cumulative[index - 1];
        const segment = cumulative[index] - previousLength;
        const ratio = segment > 0 ? (expectedLength - previousLength) / segment : 0;
        const previous = points[index - 1];

        points.splice(index, points.length, {
            x: previous.x + (points[index].x - previous.x) * ratio,
            y: previous.y + (points[index].y - previous.y) * ratio,
        });
    } else if (expectedLength > total && total > 0) {
        const last = points[points.length - 1];
        const before = points[points.length - 2];
        const length = Math.hypot(last.x - before.x, last.y - before.y);

        points.push({
            x: last.x + (last.x - before.x) / length * (expectedLength - total),
            y: last.y + (last.y - before.y) / length * (expectedLength - total),
        });
    }

    cumulative = [0];

    for (let i = 1; i < points.length; i++)
        cumulative.push(cumulative[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));

    return { points, cumulative, length: cumulative[cumulative.length - 1] };
}

function sliderBeatLength(timingPoints, time) {
    let beatLength = 500;
    let velocityMultiplier = 1;

    for (const point of timingPoints) {
        if (point.time > time) break;

        if (point.uninherited) {
            if (point.beatLength > 0) beatLength = point.beatLength;
            velocityMultiplier = 1;
        } else if (point.beatLength < 0) {
            velocityMultiplier = clamp(-100 / point.beatLength, 0.1, 10);
        }
    }

    return { beatLength, velocityMultiplier };
}

function parseStandardObjects(lines = [], timingPoints, sliderMultiplier) {
    const objects = [];

    for (const line of lines) {
        const parts = line.split(',');
        if (parts.length < 5) continue;

        const x = toNumber(parts[0], NaN);
        const y = toNumber(parts[1], NaN);
        const time = toNumber(parts[2], NaN);
        const type = Number.parseInt(parts[3], 10);

        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(time) || !Number.isFinite(type))
            continue;

        const newCombo = (type & 4) !== 0;

        if (type & 1) {
            objects.push({ type: 'circle', x, y, time, endTime: time, newCombo });
            continue;
        }

        if (type & 2) {
            const [curveType, ...rest] = String(parts[5] ?? '').split('|');
            const controlPoints = rest.map(pair => {
                const [px, py] = pair.split(':').map(Number.parseFloat);
                return { x: px, y: py };
            }).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));

            const slides = Math.max(1, Number.parseInt(parts[6] ?? '1', 10) || 1);
            const pixelLength = Math.max(0, toNumber(parts[7], 0));
            const path = fitSliderPath(
                sampleCurve((curveType || 'B').toUpperCase(), [{ x, y }, ...controlPoints]),
                pixelLength,
            );

            const { beatLength, velocityMultiplier } = sliderBeatLength(timingPoints, time);
            const velocity = (100 * sliderMultiplier * velocityMultiplier) / Math.max(1, beatLength);
            const spanDuration = velocity > 0 ? pixelLength / velocity : 0;
            const end = path.points[path.points.length - 1];

            objects.push({
                type: 'slider',
                x,
                y,
                time,
                endTime: time + spanDuration * slides,
                duration: spanDuration * slides,
                spanDuration,
                slides,
                path,
                endX: end?.x ?? x,
                endY: end?.y ?? y,
                newCombo,
            });
            continue;
        }

        if (type & 8) {
            const endTime = toNumber(String(parts[5] ?? '').split(':')[0], time + 1000);
            objects.push({ type: 'spinner', x: 256, y: 192, time, endTime: Math.max(time + 1, endTime), newCombo });
        }
    }

    return objects.sort((a, b) => a.time - b.time);
}

export function parseOsuStandard(rawText, fileName = 'beatmap.osu') {
    const text = String(rawText).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const sections = parseSections(text);

    const general = parseKeyValues(sections.general);
    const metadata = parseKeyValues(sections.metadata);
    const difficulty = parseKeyValues(sections.difficulty);

    const od = clamp(toNumber(difficulty.overalldifficulty, 5), 0, 10);
    const ar = clamp(toNumber(difficulty.approachrate, od), 0, 10);
    const cs = clamp(toNumber(difficulty.circlesize, 5), 0, 10);
    const sliderMultiplier = Math.max(0.4, toNumber(difficulty.slidermultiplier, 1.4));
    const sliderTickRate = Math.max(0.5, toNumber(difficulty.slidertickrate, 1));

    const timingPoints = parseTimingPoints(sections.timingpoints);
    const hits = parseStandardObjects(sections.hitobjects, timingPoints, sliderMultiplier);

    const firstTiming = timingPoints.find(point => point.uninherited && point.beatLength > 0);
    const firstTime = hits.length ? hits[0].time : 0;
    const lastTime = hits.reduce((max, object) => Math.max(max, object.endTime ?? object.time), firstTime);

    return {
        fileName,
        isMania: false,
        isStandard: true,
        mode: 0,
        keyCount: 0,
        overallDifficulty: od,
        approachRate: ar,
        circleSize: cs,
        drainRate: clamp(toNumber(difficulty.hpdrainrate, 5), 0, 10),
        sliderMultiplier,
        sliderTickRate,
        bpm: firstTiming ? 60000 / firstTiming.beatLength : 0,
        timingPoints,
        hits,
        firstTime,
        lastTime,
        duration: lastTime,
        noteCount: hits.length,
        holdCount: hits.filter(object => object.type !== 'circle').length,
        maxJudgements: hits.reduce((total, object) => total + (object.type === 'slider' ? 2 : 1), 0),
        audioFile: general.audiofilename || null,
        backgroundFile: parseBackgroundFile(sections.events),
        title: metadata.title || fileName.replace(/\.osu$/i, ''),
        titleUnicode: metadata.titleunicode || metadata.title || '',
        artist: metadata.artist || 'Unknown artist',
        artistUnicode: metadata.artistunicode || metadata.artist || '',
        creator: metadata.creator || 'Unknown creator',
        version: metadata.version || 'Normal',
        source: metadata.source || '',
        tags: metadata.tags || '',
    };
}
