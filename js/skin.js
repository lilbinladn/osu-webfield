// osu! skin (.osk) support: skin.ini [Mania] sections plus note/key/hit images.
// Parsing follows LegacyManiaSkinDecoder; rendering support covers column widths,
// spacing, hit position, column colours, note/key images and hit explosions.

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|bmp|webp)$/i;
const MIME_BY_EXTENSION = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    bmp: 'image/bmp',
    webp: 'image/webp',
};

export const MAX_SKIN_COLUMNS = 10;

const DEFAULT_HIT_POSITION = 402;

export function emptyImages() {
    return {
        note: Array(MAX_SKIN_COLUMNS).fill(null),
        noteH: Array(MAX_SKIN_COLUMNS).fill(null),
        noteT: Array(MAX_SKIN_COLUMNS).fill(null),
        noteL: Array(MAX_SKIN_COLUMNS).fill(null),
        key: Array(MAX_SKIN_COLUMNS).fill(null),
        keyD: Array(MAX_SKIN_COLUMNS).fill(null),
        hit: {},
    };
}

export class ManiaSkin {
    constructor({ id, name, author = '', configs = new Map(), images = emptyImages(), isDefault = false, source = '' }) {
        this.id = id;
        this.name = name;
        this.author = author;
        this.configs = configs;
        this.images = images;
        this.isDefault = isDefault;
        this.source = source;
    }

    configFor(keyCount) {
        return this.configs.get(keyCount) ?? null;
    }

    get hasImages() {
        const { note, key, hit } = this.images;
        return note.some(Boolean) || key.some(Boolean) || Object.keys(hit).length > 0;
    }
}

export const DEFAULT_SKIN = new ManiaSkin({
    id: 'default',
    name: 'Default',
    author: 'osu!webfield',
    isDefault: true,
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function splitKeyValue(line) {
    const index = line.indexOf(':');
    if (index < 0) return null;
    return { key: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
}

function parseNumberArray(value) {
    return value.split(',').map(part => {
        const number = Number.parseFloat(part);
        return Number.isFinite(number) ? number : 0;
    });
}

function parseColour(value) {
    const parts = value.split(',').map(part => Number.parseInt(part.trim(), 10));
    if (parts.length < 3 || parts.slice(0, 3).some(number => !Number.isFinite(number))) return null;

    const [r, g, b] = parts.map(number => clamp(number, 0, 255));
    return `#${[r, g, b].map(number => number.toString(16).padStart(2, '0')).join('')}`;
}

function createManiaConfig(keys) {
    return {
        keys,
        columnWidth: null,
        columnSpacing: null,
        columnLineWidth: null,
        colours: [],
        lightColours: [],
        hitPosition: DEFAULT_HIT_POSITION,
        widthForNoteHeightScale: 0,
        noteBodyStyle: 0,
    };
}

export function parseSkinIni(text) {
    const result = {
        name: '',
        author: '',
        version: '',
        configs: new Map(),
        imageLookups: {},
    };

    let section = null;
    let current = null;

    for (const rawLine of String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('//')) continue;

        const header = line.match(/^\[(.+)\]$/);
        if (header) {
            section = header[1].trim().toLowerCase();
            current = null;
            continue;
        }

        const pair = splitKeyValue(line);
        if (!pair) continue;

        if (section === 'general') {
            const key = pair.key.toLowerCase();
            if (key === 'name') result.name = pair.value;
            else if (key === 'author') result.author = pair.value;
            else if (key === 'version') result.version = pair.value;
            continue;
        }

        if (section !== 'mania') continue;

        if (pair.key.toLowerCase() === 'keys') {
            const keys = Number.parseInt(pair.value, 10);
            if (!Number.isFinite(keys) || keys < 1 || keys > MAX_SKIN_COLUMNS) {
                current = null;
                continue;
            }

            // Duplicate key counts are ignored, matching LegacyManiaSkinDecoder.
            current = result.configs.get(keys) ?? createManiaConfig(keys);
            result.configs.set(keys, current);
            continue;
        }

        if (!current) continue;

        applyManiaSetting(current, pair.key, pair.value, result.imageLookups);
    }

    return result;
}

function applyManiaSetting(config, key, value, imageLookups) {
    const lower = key.toLowerCase();

    switch (lower) {
        case 'columnwidth':
            config.columnWidth = parseNumberArray(value);
            return;
        case 'columnspacing':
            config.columnSpacing = parseNumberArray(value);
            return;
        case 'columnlinewidth':
            config.columnLineWidth = parseNumberArray(value);
            return;
        case 'hitposition': {
            const parsed = Number.parseFloat(value);
            config.hitPosition = clamp(Number.isFinite(parsed) ? parsed : DEFAULT_HIT_POSITION, 240, 480);
            return;
        }
        case 'widthfornoteheightscale': {
            const parsed = Number.parseFloat(value);
            config.widthForNoteHeightScale = Number.isFinite(parsed) ? parsed : 0;
            return;
        }
        case 'notebodystyle': {
            const parsed = Number.parseInt(value, 10);
            config.noteBodyStyle = Number.isFinite(parsed) ? parsed : 0;
            return;
        }
    }

    const colourMatch = key.match(/^colour(light)?(\d+)$/i);
    if (colourMatch) {
        const colour = parseColour(value);
        const index = Number.parseInt(colourMatch[2], 10) - 1;
        if (!colour || index < 0 || index >= MAX_SKIN_COLUMNS) return;

        const target = colourMatch[1] ? config.lightColours : config.colours;
        target[index] = colour;
        return;
    }

    if (/^(noteimage|keyimage|hit|lighting|stage)/i.test(key))
        imageLookups[lower] = value;
}

function buildImageIndex(names) {
    const index = new Map();

    const add = (key, name, is2x) => {
        const existing = index.get(key);
        if (!existing || (is2x && !existing.is2x)) index.set(key, { name, is2x });
    };

    for (const name of names) {
        if (!IMAGE_EXTENSION.test(name)) continue;

        const lower = name.toLowerCase().replace(/\\/g, '/');
        const withoutExtension = lower.replace(/\.[^.]+$/, '');
        const is2x = /@2x$/.test(withoutExtension);
        const base = withoutExtension.replace(/@2x$/, '');

        add(base, name, is2x);
        add(base.split('/').pop(), name, is2x);
    }

    return index;
}

function resolveImage(index, base) {
    if (!base) return null;

    const lower = base.toLowerCase().replace(/\\/g, '/').replace(/\.[^.]+$/, '').replace(/@2x$/, '');
    return index.get(lower)?.name ?? index.get(lower.split('/').pop())?.name ?? null;
}

async function loadBitmap(zip, entryName) {
    if (!entryName) return null;

    try {
        const bytes = await zip.readBytes(entryName);
        const extension = entryName.split('.').pop().toLowerCase();
        const blob = new Blob([bytes], { type: MIME_BY_EXTENSION[extension] ?? 'application/octet-stream' });
        return await createImageBitmap(blob);
    } catch (error) {
        console.warn(`Skin image could not be loaded: ${entryName}`, error);
        return null;
    }
}

function lookupValue(lookups, prefix, column, suffix = '') {
    const lowerSuffix = suffix.toLowerCase();

    // Stable skin.ini uses 0-based indices (eg NoteImage0L), osu! sometimes
    // accepts 1-based ones, so both are checked.
    for (const index of [column, column + 1]) {
        const value = lookups[`${prefix}${index}${lowerSuffix}`];
        if (value) return value;
    }

    return null;
}

async function loadSkinImages(zip, lookups) {
    const index = buildImageIndex(zip.names);
    const images = emptyImages();

    const load = async (base) => {
        const entryName = resolveImage(index, base);
        return entryName ? await loadBitmap(zip, entryName) : null;
    };

    for (let column = 0; column < MAX_SKIN_COLUMNS; column++) {
        const noteBase = lookupValue(lookups, 'noteimage', column) ?? `mania-note${column + 1}`;
        images.note[column] = await load(noteBase);
        images.noteH[column] = await load(lookupValue(lookups, 'noteimage', column, 'h') ?? `${noteBase}H`);
        images.noteT[column] = await load(lookupValue(lookups, 'noteimage', column, 't') ?? `${noteBase}T`);
        images.noteL[column] = await load(lookupValue(lookups, 'noteimage', column, 'l') ?? `${noteBase}L`);

        const keyBase = lookupValue(lookups, 'keyimage', column) ?? `mania-key${column + 1}`;
        images.key[column] = await load(keyBase);
        images.keyD[column] = await load(lookupValue(lookups, 'keyimage', column, 'd') ?? `${keyBase}D`);
    }

    const hitLookups = [
        [320, 'hit300g', 'mania-hit300g'],
        [300, 'hit300', 'mania-hit300'],
        [200, 'hit200', 'mania-hit200'],
        [100, 'hit100', 'mania-hit100'],
        [50, 'hit50', 'mania-hit50'],
        [0, 'hit0', 'mania-hit0'],
    ];

    for (const [value, lookupKey, fallback] of hitLookups) {
        const image = await load(lookups[lookupKey] ?? fallback);
        if (image) images.hit[value] = image;
    }

    return images;
}

export async function loadSkin(zip, fileName = 'skin.osk') {
    const iniEntry = zip.names.find(name => name.toLowerCase().endsWith('skin.ini'));
    if (!iniEntry) throw new Error('No skin.ini found in this skin');

    const parsed = parseSkinIni(await zip.readText(iniEntry));
    if (!parsed.configs.size && !zip.names.some(name => IMAGE_EXTENSION.test(name)))
        throw new Error('This skin has no mania configuration or images');

    const images = await loadSkinImages(zip, parsed.imageLookups);

    return new ManiaSkin({
        id: `skin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: parsed.name || fileName.replace(/\.osk$/i, ''),
        author: parsed.author,
        configs: parsed.configs,
        images,
        source: fileName,
    });
}
