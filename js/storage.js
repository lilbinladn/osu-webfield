// IndexedDB persistence for the beatmap library and the local account.
//
// The library stores the original .osz/.osu file next to a little metadata, so
// a reload can rebuild every chart without downloading it again and a deleted
// mapset can be removed from storage in one go. The account is a single record
// holding the profile, stats source (play history) and osu! link.

const DB_NAME = 'osu-webfield';
const DB_VERSION = 1;
const SET_STORE = 'beatmapsets';
const PROFILE_STORE = 'profile';
const PROFILE_ID = 'profile';

let dbPromise = null;

function requestAsPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('The browser rejected a storage request'));
    });
}

function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('This browser has no IndexedDB storage'));
            return;
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(SET_STORE))
                db.createObjectStore(SET_STORE, { keyPath: 'id' });
            if (!db.objectStoreNames.contains(PROFILE_STORE))
                db.createObjectStore(PROFILE_STORE, { keyPath: 'id' });
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Saved libraries are not available'));
        request.onblocked = () => reject(new Error('Another tab is upgrading the saved library'));
    });

    // A failed open should be retried next time instead of caching the error.
    dbPromise.catch(() => {
        dbPromise = null;
    });

    return dbPromise;
}

export async function listBeatmapsets() {
    const db = await openDB();
    return await requestAsPromise(db.transaction(SET_STORE, 'readonly').objectStore(SET_STORE).getAll());
}

export async function saveBeatmapset(record) {
    if (!record?.id) throw new Error('A mapset needs an id before it can be saved');

    const db = await openDB();
    await requestAsPromise(db.transaction(SET_STORE, 'readwrite').objectStore(SET_STORE).put(record));
}

export async function deleteBeatmapset(id) {
    const db = await openDB();
    await requestAsPromise(db.transaction(SET_STORE, 'readwrite').objectStore(SET_STORE).delete(id));
}

export async function loadProfile() {
    const db = await openDB();
    const record = await requestAsPromise(db.transaction(PROFILE_STORE, 'readonly').objectStore(PROFILE_STORE).get(PROFILE_ID));
    return record ?? null;
}

export async function saveProfile(profile) {
    const db = await openDB();
    await requestAsPromise(db.transaction(PROFILE_STORE, 'readwrite').objectStore(PROFILE_STORE).put({
        ...profile,
        id: PROFILE_ID,
    }));
}
