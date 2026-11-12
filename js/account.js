// The local webfield account: name, osu! profile link, play history, and the
// sync code that carries all of it into another browser or device.

const SYNC_PREFIX = 'osu-webfield/1/';
const MAX_PLAYS = 500;

// Only used to pick the best grade; unknown grades rank below everything.
const GRADE_RANK = { X: 8, SS: 7, S: 6, A: 5, B: 4, C: 3, D: 2, F: 1 };

const gradeRank = grade => GRADE_RANK[grade] ?? 0;

const text = (value, limit = 64) => (typeof value === 'string' ? value.slice(0, limit) : '');
const stamp = value => (typeof value === 'string' && value ? value : new Date().toISOString());

export function defaultProfile() {
    const now = new Date().toISOString();
    return {
        version: 1,
        username: '',
        createdAt: now,
        updatedAt: now,
        osu: null,
        plays: [],
    };
}

function normalisePlay(raw) {
    const score = Number(raw.score);
    const accuracy = Number(raw.accuracy);

    return {
        id: text(raw.id, 32) || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        at: stamp(raw.at),
        title: text(raw.title, 120),
        artist: text(raw.artist, 120),
        version: text(raw.version, 80),
        mode: raw.mode === 'std' ? 'std' : 'mania',
        keys: Number.isFinite(Number(raw.keys)) ? Number(raw.keys) : 0,
        score: Number.isFinite(score) ? Math.round(score) : 0,
        accuracy: Number.isFinite(accuracy) ? accuracy : 0,
        grade: text(raw.grade, 3) || 'D',
        maxCombo: Number.isFinite(Number(raw.maxCombo)) ? Math.round(Number(raw.maxCombo)) : 0,
        mods: Array.isArray(raw.mods) ? raw.mods.filter(mod => typeof mod === 'string').slice(0, 8) : [],
        rate: Number.isFinite(Number(raw.rate)) ? Number(raw.rate) : 1,
        failed: raw.failed === true,
        durationMs: Number.isFinite(Number(raw.durationMs)) ? Math.max(0, Math.round(Number(raw.durationMs))) : 0,
    };
}

// Accepts anything that came out of storage, a sync code or a hand-edited file.
export function sanitiseProfile(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const plays = Array.isArray(raw.plays) ? raw.plays : [];
    const osu = raw.osu && typeof raw.osu === 'object'
        ? {
            userId: Number.isFinite(Number(raw.osu.userId)) && Number(raw.osu.userId) > 0
                ? Math.round(Number(raw.osu.userId))
                : null,
            username: text(raw.osu.username, 32) || null,
            linkedAt: raw.osu.linkedAt ? stamp(raw.osu.linkedAt) : null,
        }
        : null;

    return {
        version: 1,
        username: text(raw.username, 32).trim(),
        createdAt: stamp(raw.createdAt),
        updatedAt: stamp(raw.updatedAt),
        osu: osu && (osu.userId || osu.username) ? osu : null,
        plays: plays.filter(play => play && typeof play === 'object').slice(0, MAX_PLAYS).map(normalisePlay),
    };
}

export function recordPlay(profile, entry, summary) {
    const base = profile ?? defaultProfile();
    const map = entry.map;

    const play = normalisePlay({
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        at: new Date().toISOString(),
        title: map.title || map.fileName,
        artist: map.artist,
        version: map.version,
        mode: map.mode === 0 ? 'std' : 'mania',
        keys: map.keyCount || 0,
        score: summary.score,
        accuracy: summary.accuracy,
        grade: summary.grade,
        maxCombo: summary.maxCombo,
        mods: summary.mods,
        rate: summary.rate,
        failed: summary.failed,
        durationMs: map.duration ?? map.lastTime ?? 0,
    });

    return {
        ...base,
        plays: [play, ...(base.plays ?? []).filter(candidate => candidate.id !== play.id)].slice(0, MAX_PLAYS),
        updatedAt: play.at,
    };
}

export function profileStats(profile) {
    const plays = Array.isArray(profile?.plays) ? profile.plays : [];
    const cleared = plays.filter(play => !play.failed);

    const best = plays.reduce((top, play) => (play.score > (top?.score ?? -1) ? play : top), null);
    const bestGrade = plays.reduce((top, play) => (gradeRank(play.grade) > gradeRank(top) ? play.grade : top), '—');

    return {
        plays: plays.length,
        cleared: cleared.length,
        failed: plays.length - cleared.length,
        totalScore: plays.reduce((sum, play) => sum + play.score, 0),
        accuracy: cleared.length
            ? cleared.reduce((sum, play) => sum + play.accuracy, 0) / cleared.length
            : 0,
        best,
        bestScore: best?.score ?? 0,
        bestGrade,
        maxCombo: plays.reduce((max, play) => Math.max(max, play.maxCombo), 0),
        playTimeMs: plays.reduce((sum, play) => sum + play.durationMs, 0),
    };
}

// osu.ppy.sh has no browser sign-in and its API sends no CORS headers, so the
// link is an identity reference only: it powers the avatar and profile links.
export function parseOsuProfile(input) {
    const raw = String(input ?? '').trim();
    if (!raw) return null;

    const url = raw.match(/osu\.ppy\.sh\/users\/(\d+)(?:\/([^/?#\s]+))?/i);
    if (url) {
        return {
            userId: Number(url[1]),
            username: url[2] ? decodeURIComponent(url[2].replace(/[+_]/g, ' ')) : null,
        };
    }

    if (/^\d{1,9}$/.test(raw)) return { userId: Number(raw), username: null };

    if (raw.length > 32 || !/^[\w .\-[\]]+$/.test(raw)) return null;

    return { userId: null, username: raw };
}

export function osuProfileUrl(osu) {
    if (!osu) return null;
    if (osu.userId) return `https://osu.ppy.sh/users/${osu.userId}`;
    if (osu.username) return `https://osu.ppy.sh/users/${encodeURIComponent(osu.username)}`;
    return null;
}

export function encodeSyncCode(profile) {
    const payload = {
        version: 1,
        username: profile?.username ?? '',
        createdAt: profile?.createdAt,
        updatedAt: profile?.updatedAt,
        osu: profile?.osu ?? null,
        plays: (profile?.plays ?? []).slice(0, MAX_PLAYS),
    };

    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);

    return `${SYNC_PREFIX}${btoa(binary)}`;
}

export function decodeSyncCode(code) {
    const raw = String(code ?? '').trim();
    if (!raw) return null;

    const body = raw.startsWith(SYNC_PREFIX) ? raw.slice(SYNC_PREFIX.length) : raw;

    try {
        const binary = atob(body.replace(/\s+/g, ''));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        return sanitiseProfile(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
        return null;
    }
}

// Applying a code merges play histories by id, so syncing back and forth never
// duplicates a play or loses one that only exists on the other device.
export function mergeProfiles(current, incoming) {
    if (!incoming) return current;
    if (!current) return incoming;

    const byId = new Map();

    for (const play of [...(current.plays ?? []), ...(incoming.plays ?? [])]) {
        if (play?.id) byId.set(play.id, play);
    }

    const plays = [...byId.values()]
        .sort((a, b) => String(b.at).localeCompare(String(a.at)))
        .slice(0, MAX_PLAYS);

    const created = [current.createdAt, incoming.createdAt].filter(Boolean).sort();

    return {
        version: 1,
        username: current.username || incoming.username || '',
        createdAt: created[0] ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        osu: incoming.osu ?? current.osu ?? null,
        plays,
    };
}
