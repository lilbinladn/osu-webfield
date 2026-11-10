// Key bindings: defaults from osu!'s VariantMappingGenerator plus a
// localStorage-backed override per key count.

export const KEY_LAYOUTS = {
    1: ['Space'],
    2: ['KeyF', 'KeyJ'],
    3: ['KeyF', 'Space', 'KeyJ'],
    4: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
    5: ['KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK'],
    6: ['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'],
    7: ['KeyS', 'KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK', 'KeyL'],
    8: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'],
    9: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'],
    10: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyV', 'KeyN', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'],
};

export const SUPPORTED_KEY_COUNTS = Object.keys(KEY_LAYOUTS).map(Number);

const STORAGE_KEY = 'osu-mania-web-keybinds';

export function keyLabel(code) {
    if (!code) return '—';
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code === 'Semicolon') return ';';
    if (code === 'Quote') return "'";
    if (code === 'Comma') return ',';
    if (code === 'Period') return '.';
    if (code === 'Slash') return '/';
    if (code === 'BracketLeft') return '[';
    if (code === 'BracketRight') return ']';
    if (code === 'Backslash') return '\\';
    if (code === 'Minus') return '-';
    if (code === 'Equal') return '=';
    if (code === 'Backquote') return '`';
    if (code === 'Space') return 'Space';
    if (code.startsWith('Arrow')) return code.slice(5);
    if (code.startsWith('Numpad')) return 'Num' + code.slice(6);
    return code.replace(/^(Control|Shift|Alt|Meta)(Left|Right)$/, '$1');
}

export function defaultKeybinds() {
    const result = {};
    for (const [count, codes] of Object.entries(KEY_LAYOUTS))
        result[count] = [...codes];
    return result;
}

function isValidLayout(codes, count) {
    return Array.isArray(codes)
        && codes.length === count
        && codes.every(code => typeof code === 'string' && code.length > 0)
        && new Set(codes).size === count;
}

export function loadKeybinds() {
    const result = defaultKeybinds();

    try {
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');

        for (const [key, codes] of Object.entries(stored)) {
            const count = Number(key);
            if (!KEY_LAYOUTS[count]) continue;
            if (!isValidLayout(codes, count)) continue;
            result[count] = [...codes];
        }
    } catch {
        // Ignore malformed storage and fall back to defaults.
    }

    return result;
}

export function saveKeybinds(binds) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(binds));
    } catch {
        // Storage unavailable: bindings stay for this session only.
    }
}

// Assigns `code` to `column`. If the key is already used by another column in
// the same layout, the two columns swap keys instead of creating a conflict.
export function setKeybind(binds, keyCount, column, code) {
    const codes = [...(binds[keyCount] ?? KEY_LAYOUTS[keyCount])];

    if (column < 0 || column >= codes.length) return binds;

    const existing = codes.indexOf(code);
    if (existing === column) return binds;

    if (existing >= 0) codes[existing] = codes[column];
    codes[column] = code;

    binds[keyCount] = codes;
    return binds;
}

export function resetKeybinds(binds, keyCount) {
    binds[keyCount] = [...(KEY_LAYOUTS[keyCount] ?? [])];
    return binds;
}
