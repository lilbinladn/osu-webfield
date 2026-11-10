// Rate/window/score mods shared by the mania and osu!standard engines.
// Constants mirror ManiaModEasy / ManiaModHardRock (hit window multipliers),
// the rate adjust mods, and ManiaScoreMultiplierCalculator.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const MODS = [
    {
        id: 'EZ',
        name: 'Easy',
        description: 'Hit windows multiplied by 1.4. Score multiplier 0.5x.',
        windowMultiplier: 1 / 1.4,
        scoreMultiplier: 0.5,
    },
    {
        id: 'HR',
        name: 'Hard Rock',
        description: 'Hit windows divided by 1.4.',
        windowMultiplier: 1.4,
    },
    {
        id: 'DT',
        name: 'Double Time',
        description: 'Song plays faster. Adjust the speed below.',
        rate: 1.5,
        adjustable: { min: 1.01, max: 2, step: 0.01, default: 1.5 },
    },
    {
        id: 'HT',
        name: 'Half Time',
        description: 'Song plays slower. Score multiplier scales with the speed.',
        rate: 0.75,
        adjustable: { min: 0.5, max: 0.99, step: 0.01, default: 0.75 },
    },
    {
        id: 'HD',
        name: 'Hidden',
        description: 'Notes fade out before they reach the hit line.',
        hidden: true,
    },
    {
        id: 'MR',
        name: 'Mirror',
        description: 'Mania columns are flipped horizontally.',
        maniaOnly: true,
        mirror: true,
    },
    {
        id: 'RD',
        name: 'Random',
        description: 'Mania columns are shuffled on every attempt.',
        maniaOnly: true,
        random: true,
    },
];

export const MOD_BY_ID = new Map(MODS.map(mod => [mod.id, mod]));

// Mods that cannot be active together (mirrors the C# IncompatibleMods lists).
export const MOD_CONFLICTS = {
    EZ: ['HR'],
    HR: ['EZ'],
    DT: ['HT'],
    HT: ['DT'],
    MR: ['RD'],
    RD: ['MR'],
};

export function rateFor(mod, rates = {}) {
    if (!mod?.adjustable) return 1;

    const { min, max, default: fallback } = mod.adjustable;
    const value = Number.parseFloat(rates[mod.id]);
    return clamp(Number.isFinite(value) ? value : fallback, min, max);
}

// ManiaScoreMultiplierCalculator.rateAdjustMultiplier for rate-reducing mods.
export function rateScoreMultiplier(rate) {
    const stepped = Math.trunc(rate * 10) / 10;
    const value = stepped - 1;

    return rate >= 1 ? 1 + value / 5 : 0.6 + value;
}

export function resolveMods(ids = [], rates = {}) {
    const selected = new Set(ids.filter(id => MOD_BY_ID.has(id)));
    const active = [];

    // Resolve in canonical order so stored/conflicting selections are stable.
    for (const mod of MODS) {
        if (!selected.has(mod.id)) continue;
        if (active.some(other => (MOD_CONFLICTS[other.id] ?? []).includes(mod.id))) continue;
        active.push(mod);
    }

    let rate = 1;
    let windowMultiplier = 1;
    let scoreMultiplier = 1;

    for (const mod of active) {
        const modRate = rateFor(mod, rates);
        rate *= modRate;
        windowMultiplier *= mod.windowMultiplier ?? 1;

        // Only rate reductions affect the mania score multiplier (DT stays 1x).
        if (mod.adjustable && modRate < 1) scoreMultiplier *= rateScoreMultiplier(modRate);
        else scoreMultiplier *= mod.scoreMultiplier ?? 1;
    }

    return {
        ids: active.map(mod => mod.id),
        acronyms: active.map(mod => mod.id),
        rate,
        windowMultiplier,
        scoreMultiplier,
        hidden: active.some(mod => mod.hidden),
        mirror: active.some(mod => mod.mirror),
        random: active.some(mod => mod.random),
        maniaOnly: active.filter(mod => mod.maniaOnly).map(mod => mod.id),
    };
}

// Applies mirror/random column mappings. Returns a permutation where
// `permutation[originalColumn] = newColumn`.
export function buildColumnPermutation(keyCount, mods) {
    const permutation = Array.from({ length: keyCount }, (_, index) => index);

    if (mods?.mirror) {
        for (let i = 0; i < keyCount; i++)
            permutation[i] = keyCount - 1 - i;
    }

    if (mods?.random) {
        for (let i = keyCount - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [permutation[i], permutation[j]] = [permutation[j], permutation[i]];
        }
    }

    return permutation;
}
