// Minimal ZIP reader used to open osu! beatmap packages (.osz).
// Supports stored + deflated entries through the browser's DecompressionStream,
// so no third-party zip library is needed.

const decoder = new TextDecoder('utf-8');

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const norm = (name) => name.replace(/\\/g, '/').toLowerCase();

export async function readZip(fileOrBytes) {
    const bytes = fileOrBytes instanceof Uint8Array
        ? fileOrBytes
        : fileOrBytes instanceof ArrayBuffer
            ? new Uint8Array(fileOrBytes)
            : new Uint8Array(await fileOrBytes.arrayBuffer());

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const eocd = findEndOfCentralDirectory(view, bytes.length);
    if (eocd < 0)
        throw new Error('Not a zip archive (.osz expected)');

    const entryCount = view.getUint16(eocd + 10, true);
    const centralOffset = view.getUint32(eocd + 16, true);

    const entries = new Map();
    let cursor = centralOffset;

    for (let i = 0; i < entryCount; i++) {
        if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== CENTRAL_SIG)
            break;

        const method = view.getUint16(cursor + 10, true);
        const compressedSize = view.getUint32(cursor + 20, true);
        const uncompressedSize = view.getUint32(cursor + 24, true);
        const nameLength = view.getUint16(cursor + 28, true);
        const extraLength = view.getUint16(cursor + 30, true);
        const commentLength = view.getUint16(cursor + 32, true);
        const localOffset = view.getUint32(cursor + 42, true);

        const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
        if (!name.endsWith('/')) {
            entries.set(norm(name), {
                name: name.replace(/\\/g, '/'),
                method,
                compressedSize,
                uncompressedSize,
                localOffset,
            });
        }

        cursor += 46 + nameLength + extraLength + commentLength;
    }

    const cache = new Map();

    function findEntry(name) {
        const key = norm(name);
        if (!key) return null;

        const direct = entries.get(key);
        if (direct) return direct;

        const base = key.split('/').pop();
        for (const entry of entries.values()) {
            if (entry.name.toLowerCase().split('/').pop() === base)
                return entry;
        }

        return null;
    }

    async function readBytes(name) {
        const entry = findEntry(name);
        if (!entry) throw new Error(`File not found in archive: ${name}`);

        const key = entry.name.toLowerCase();
        if (cache.has(key)) return cache.get(key);

        if (view.getUint32(entry.localOffset, true) !== LOCAL_SIG)
            throw new Error(`Corrupt zip entry: ${entry.name}`);

        const nameLength = view.getUint16(entry.localOffset + 26, true);
        const extraLength = view.getUint16(entry.localOffset + 28, true);
        const dataStart = entry.localOffset + 30 + nameLength + extraLength;

        if (dataStart + entry.compressedSize > bytes.length)
            throw new Error(`Truncated zip entry: ${entry.name}`);

        const raw = bytes.subarray(dataStart, dataStart + entry.compressedSize);
        let data;

        if (entry.method === 0) {
            data = raw;
        } else if (entry.method === 8) {
            if (typeof DecompressionStream === 'undefined')
                throw new Error('This browser cannot decompress zip archives');

            const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
            data = new Uint8Array(await new Response(stream).arrayBuffer());
        } else {
            throw new Error(`Unsupported zip compression method ${entry.method} (${entry.name})`);
        }

        cache.set(key, data);
        return data;
    }

    return {
        names: [...entries.values()].map(e => e.name),
        has: (name) => !!findEntry(name),
        readBytes,
        async readText(name) {
            return decoder.decode(await readBytes(name));
        },
    };
}

function findEndOfCentralDirectory(view, byteLength) {
    const start = Math.max(0, byteLength - 0xffff - 22);
    for (let i = byteLength - 22; i >= start; i--) {
        if (view.getUint32(i, true) === EOCD_SIG)
            return i;
    }
    return -1;
}
