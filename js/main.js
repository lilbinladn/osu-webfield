// Application wiring: beatmap library, mods, keybinds, skins, screens and HUD.

import { parseOsu, parseOsuStandard, AUDIO_EXTENSIONS } from './beatmap.js';
import { readZip } from './zip.js';
import { AudioEngine } from './audio.js';
import { ManiaGame, JUDGEMENTS, JUDGEMENT_ORDER } from './game.js';
import { MODS, MOD_CONFLICTS, rateFor, resolveMods } from './mods.js';
import {
    SUPPORTED_KEY_COUNTS,
    keyLabel,
    loadKeybinds,
    saveKeybinds,
    setKeybind,
    resetKeybinds,
} from './keybinds.js';
import { DEFAULT_SKIN, loadSkin } from './skin.js';
import { computeStarRating } from './difficulty.js';
import { OsuGame, STD_JUDGEMENTS, STD_JUDGEMENT_ORDER } from './stdgame.js';

const $ = selector => document.querySelector(selector);

// v2 key so older sessions pick up the new defaults (autoplay off, clicks on).
const SETTINGS_KEY = 'osu-web-settings-v2';
const MODS_KEY = 'osu-web-mods';
const RATES_KEY = 'osu-web-rates';

const DEFAULT_SETTINGS = {
    scrollSpeed: 20,
    backgroundDim: 70,
    volume: 70,
    auto: false,
    clicks: true,
    offset: 0,
};

const DEFAULT_RATES = { DT: 1.5, HT: 0.75 };

// Famous mapsets are fetched once from the public mirror and then served from
// Cache Storage, so a reload does not download them again.
const FEATURED_CACHE = 'osu-webfield-featured-v1';
const FEATURED_MAPS = [
    { id: 1, title: 'DISCO PRINCE' },
    { id: 7237, title: 'Butterfly' },
    { id: 700945, title: 'Ievan Polkka' },
    { id: 993703, title: 'Ievan Polkka (mania)' },
    { id: 867737, title: 'The Big Black' },
    { id: 89139, title: 'Blue Zenith' },
    { id: 2405981, title: 'FREEDOM DiVE' },
];
let featuredStarted = false;

const dom = {
    screens: document.querySelectorAll('.screen'),
    dropZone: $('#drop-zone'),
    fileInput: $('#file-input'),
    status: $('#import-status'),
    list: $('#beatmap-list'),
    count: $('#library-count'),
    stage: $('#stage'),
    score: $('#hud-score'),
    accuracy: $('#hud-acc'),
    combo: $('#hud-combo'),
    judgement: $('#hud-judgement'),
    progress: $('#hud-progress-fill'),
    health: $('#hud-health-fill'),
    vignette: $('#low-health'),
    onlineForm: $('#online-search'),
    onlineQuery: $('#online-query'),
    onlineMode: $('#online-mode'),
    onlineSubmit: $('#online-submit'),
    onlineStatus: $('#online-status'),
    onlineResults: $('#online-results'),
    title: $('#hud-title'),
    artist: $('#hud-artist'),
    diff: $('#hud-diff'),
    pauseOverlay: $('#pause-overlay'),
    speed: $('#opt-speed'),
    speedValue: $('#opt-speed-value'),
    dim: $('#opt-dim'),
    dimValue: $('#opt-dim-value'),
    volume: $('#opt-volume'),
    volumeValue: $('#opt-volume-value'),
    auto: $('#opt-auto'),
    clicks: $('#opt-clicks'),
    offset: $('#opt-offset'),
    offsetValue: $('#opt-offset-value'),
    calibrate: $('#btn-calibrate'),
    calibrateTap: $('#btn-calibrate-tap'),
    calibrateApply: $('#btn-calibrate-apply'),
    calibrateStatus: $('#calibrate-status'),
    calibratePulse: $('#calibration-pulse'),
    modGrid: $('#mod-grid'),
    modSummary: $('#mod-summary'),
    keysCount: $('#keys-count'),
    keyRows: $('#keybind-rows'),
    skinList: $('#skin-list'),
    skinInput: $('#skin-input'),
};

const audio = new AudioEngine();

const state = {
    beatmaps: [],
    selectedId: null,
    currentId: null,
    game: null,
    settings: loadSettings(),
    mods: loadMods(),
    rates: loadRates(),
    keybinds: loadKeybinds(),
    keyEditorCount: 4,
    skins: [],
    activeSkinId: 'default',
};

let keyCapture = null;

function loadSettings() {
    try {
        const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
        return { ...DEFAULT_SETTINGS, ...stored };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

function saveSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch {
        // Storage can be unavailable; settings then just do not persist.
    }
}

// ------------------------------------------------------ offset calibration

const OFFSET_LIMIT = 200;
const CALIBRATION_INTERVAL = 0.5; // seconds between beats (120 BPM)
const CALIBRATION_BEATS = 16;

const calibration = { active: false, raf: 0, beats: [], taps: [], handler: null };

const signedMs = value => `${value > 0 ? '+' : ''}${Math.round(value)}`;

// Positive offset moves hit windows later in real time, so a player who
// consistently taps late can line the windows up with their taps.
function setOffset(value, { persist = true } = {}) {
    const offset = Math.min(OFFSET_LIMIT, Math.max(-OFFSET_LIMIT, Math.round(Number(value) || 0)));
    state.settings.offset = offset;
    if (persist) saveSettings();
    dom.offset.value = String(offset);
    dom.offsetValue.textContent = `${signedMs(offset)} ms`;
    if (state.game) state.game.offsetSeconds = offset / 1000;
}

function calibrationSummary() {
    const recent = calibration.taps.slice(-12);
    if (recent.length < 4) return null;

    const average = recent.reduce((sum, value) => sum + value, 0) / recent.length;
    const jitter = Math.sqrt(recent.reduce((sum, value) => sum + (value - average) ** 2, 0) / recent.length);

    return { average, jitter, count: recent.length };
}

function stopCalibration() {
    if (!calibration.active) return;

    calibration.active = false;
    audio.stopBeats();
    cancelAnimationFrame(calibration.raf);
    if (calibration.handler) window.removeEventListener('keydown', calibration.handler, true);
    calibration.handler = null;

    dom.calibrate.textContent = 'Start metronome';
    dom.calibrateTap.hidden = true;
    dom.calibratePulse.classList.remove('active');
    dom.calibratePulse.style.transform = '';
    dom.calibratePulse.style.opacity = '';

    const summary = calibrationSummary();
    if (summary) {
        dom.calibrateApply.hidden = false;
        dom.calibrateStatus.textContent = `${summary.count} taps · average ${signedMs(summary.average)} ms · jitter ${Math.round(summary.jitter)} ms`;
    } else {
        dom.calibrateApply.hidden = true;
        dom.calibrateStatus.textContent = 'Not enough taps — start the metronome and tap on at least four beats.';
    }
}

function registerCalibrationTap() {
    if (!calibration.active) return;

    const now = audio.now();
    let nearest = calibration.beats[0];
    for (const beat of calibration.beats)
        if (Math.abs(beat - now) < Math.abs(nearest - now)) nearest = beat;

    const error = (now - nearest) * 1000;
    if (Math.abs(error) > 300) {
        dom.calibrateStatus.textContent = 'Too far from a click — tap exactly with the beat.';
        return;
    }

    calibration.taps.push(error);
    const summary = calibrationSummary();

    if (summary) {
        dom.calibrateApply.hidden = false;
        dom.calibrateStatus.textContent = `${summary.count} taps · average ${signedMs(summary.average)} ms · jitter ${Math.round(summary.jitter)} ms`;
    } else {
        dom.calibrateStatus.textContent = `Tap ${calibration.taps.length}: ${signedMs(error)} ms`;
    }

    if (calibration.taps.length >= 12) stopCalibration();
}

function startCalibration() {
    if (calibration.active) {
        stopCalibration();
        return;
    }

    audio.ensure();
    audio.resume();
    audio.stopBeats();
    audio.setClicksEnabled(state.settings.clicks);

    const start = audio.now() + 0.6;
    calibration.beats = Array.from({ length: CALIBRATION_BEATS }, (_, index) => start + index * CALIBRATION_INTERVAL);
    calibration.taps = [];

    for (let index = 0; index < calibration.beats.length; index++)
        audio.beat(calibration.beats[index], index % 4 === 0);

    calibration.active = true;
    calibration.handler = event => {
        if (event.code !== 'Space' && event.code !== 'KeyZ' && event.code !== 'KeyX') return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) registerCalibrationTap();
    };
    window.addEventListener('keydown', calibration.handler, true);

    dom.calibrate.textContent = 'Stop metronome';
    dom.calibrateTap.hidden = false;
    dom.calibrateApply.hidden = true;
    dom.calibratePulse.classList.add('active');
    dom.calibrateStatus.textContent = 'Listen for the clicks, then tap Space (or Tap) on each beat.';

    const lastBeat = calibration.beats[calibration.beats.length - 1];

    const tick = () => {
        if (!calibration.active) return;

        const now = audio.now();

        let index = 0;
        for (let i = 0; i < calibration.beats.length; i++)
            if (calibration.beats[i] <= now) index = i;

        const phase = Math.max(0, Math.min(1, (now - calibration.beats[index]) / CALIBRATION_INTERVAL));
        dom.calibratePulse.style.transform = `scale(${(1 + (1 - phase) * 0.45).toFixed(3)})`;
        dom.calibratePulse.style.opacity = String(0.35 + (1 - phase) * 0.65);

        if (now > lastBeat + 0.5) {
            stopCalibration();
            return;
        }

        calibration.raf = requestAnimationFrame(tick);
    };

    calibration.raf = requestAnimationFrame(tick);
}

function applyCalibration() {
    const summary = calibrationSummary();
    if (!summary) return;

    if (calibration.active) stopCalibration();
    setOffset(summary.average);
    dom.calibrateApply.hidden = true;
    dom.calibrateStatus.textContent = `Applied ${signedMs(state.settings.offset)} ms — hit windows now land ${state.settings.offset >= 0 ? 'later' : 'earlier'} by that much.`;
}

function loadMods() {
    try {
        const stored = JSON.parse(localStorage.getItem(MODS_KEY) ?? '[]');
        if (!Array.isArray(stored)) return [];
        return stored.filter(id => MODS.some(mod => mod.id === id));
    } catch {
        return [];
    }
}

function saveMods() {
    try {
        localStorage.setItem(MODS_KEY, JSON.stringify(state.mods));
    } catch {
        // Ignore.
    }
}

function loadRates() {
    try {
        const stored = JSON.parse(localStorage.getItem(RATES_KEY) ?? '{}');
        return { ...DEFAULT_RATES, ...(stored && typeof stored === 'object' ? stored : {}) };
    } catch {
        return { ...DEFAULT_RATES };
    }
}

function saveRates() {
    try {
        localStorage.setItem(RATES_KEY, JSON.stringify(state.rates));
    } catch {
        // Ignore.
    }
}

const uid = () => Math.random().toString(36).slice(2, 10);

// Star ratings only depend on the clock rate, so cache one value per rate.
const starCache = new Map();

function starRatingFor(entry, rate) {
    // Standard star ratings are not ported yet; only mania charts are rated.
    if (entry.map.mode !== 3) return null;

    const key = `${entry.id}|${rate}`;

    let rating = starCache.get(key);
    if (rating === undefined) {
        rating = computeStarRating(entry.map, { rate });
        starCache.set(key, rating);
    }

    return rating;
}

function modeTag(map) {
    return map.mode === 0 ? 'osu!std' : `${map.keyCount}K`;
}

function setScreen(name) {
    for (const screen of dom.screens)
        screen.classList.toggle('active', screen.id === `screen-${name}`);
}

function setStatus(message) {
    dom.status.textContent = message;
}

function activeSkin() {
    return state.skins.find(skin => skin.id === state.activeSkinId) ?? DEFAULT_SKIN;
}

// ------------------------------------------------------------------- tabs

function activateTab(name) {
    for (const tab of document.querySelectorAll('.tab'))
        tab.classList.toggle('active', tab.dataset.tab === name);

    for (const panel of document.querySelectorAll('.tab-panel'))
        panel.classList.toggle('active', panel.dataset.panel === name);
}

function bindTabs() {
    for (const tab of document.querySelectorAll('.tab'))
        tab.addEventListener('click', () => activateTab(tab.dataset.tab));
}

// ------------------------------------------------------------------- mods

function renderMods() {
    dom.modGrid.replaceChildren();

    for (const mod of MODS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'mod';
        if (state.mods.includes(mod.id)) button.classList.add('active');

        const acronym = document.createElement('span');
        acronym.className = 'mod-acronym';
        acronym.textContent = mod.id;

        const name = document.createElement('span');
        name.className = 'mod-name';
        name.textContent = mod.name;

        const description = document.createElement('span');
        description.className = 'mod-desc';
        description.textContent = mod.description;

        button.append(acronym, name, description);
        button.addEventListener('click', () => toggleMod(mod.id));
        dom.modGrid.append(button);
    }

    for (const mod of MODS) {
        if (!mod.adjustable || !state.mods.includes(mod.id)) continue;

        const wrapper = document.createElement('label');
        wrapper.className = 'mod-rate';

        const label = document.createElement('span');
        const output = document.createElement('b');
        const value = rateFor(mod, state.rates);
        output.textContent = `${value.toFixed(2)}x`;
        label.append(`${mod.name} speed `, output);

        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(mod.adjustable.min);
        input.max = String(mod.adjustable.max);
        input.step = String(mod.adjustable.step);
        input.value = String(value);

        input.addEventListener('input', () => {
            state.rates[mod.id] = Number.parseFloat(input.value);
            output.textContent = `${state.rates[mod.id].toFixed(2)}x`;
            saveRates();
            updateModSummary();
            renderLibrary();
        });

        wrapper.append(label, input);
        dom.modGrid.append(wrapper);
    }

    updateModSummary();
}

function updateModSummary() {
    const resolved = resolveMods(state.mods, state.rates);
    const parts = [];

    if (resolved.ids.length) {
        parts.push(resolved.ids.join(''));
        parts.push(`${resolved.rate.toFixed(2)}x rate`);
        parts.push(`${resolved.scoreMultiplier.toFixed(2)}x score`);
    } else {
        parts.push('No mods selected.');
    }

    dom.modSummary.textContent = parts.join(' · ');
}

function toggleMod(id) {
    const active = new Set(state.mods);

    if (active.has(id)) {
        active.delete(id);
    } else {
        for (const conflict of MOD_CONFLICTS[id] ?? [])
            active.delete(conflict);
        active.add(id);
    }

    state.mods = [...active];
    saveMods();
    renderMods();
    // Star ratings follow the rate, so DT/HT change the library values.
    renderLibrary();
}

// ---------------------------------------------------------------- keybinds

function renderKeyEditor() {
    const count = state.keyEditorCount;
    const codes = state.keybinds[count] ?? [];

    dom.keysCount.value = String(count);
    dom.keyRows.replaceChildren();

    codes.forEach((code, column) => {
        const row = document.createElement('div');
        row.className = 'keybind-row';

        const label = document.createElement('span');
        label.textContent = `${count}K · column ${column + 1}`;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'key-btn';
        button.textContent = keyLabel(code);
        button.addEventListener('click', () => beginKeyCapture(count, column, button));

        row.append(label, button);
        dom.keyRows.append(row);
    });
}

function beginKeyCapture(keyCount, column, button) {
    cancelKeyCapture();

    keyCapture = { keyCount, column, button };
    button.textContent = 'Press a key…';
    button.classList.add('capturing');
}

function cancelKeyCapture() {
    if (!keyCapture) return;
    keyCapture = null;
    renderKeyEditor();
}

function handleCaptureKey(event) {
    if (!keyCapture) return false;

    event.preventDefault();
    event.stopPropagation();

    if (event.code === 'Escape') {
        cancelKeyCapture();
        return true;
    }

    // Tab is reserved for moving focus around the UI.
    if (event.code === 'Tab') return true;

    setKeybind(state.keybinds, keyCapture.keyCount, keyCapture.column, event.code);
    saveKeybinds(state.keybinds);

    keyCapture = null;
    renderKeyEditor();
    return true;
}

// ------------------------------------------------------------------- skins

function renderSkins() {
    dom.skinList.replaceChildren();

    const entries = [
        { id: DEFAULT_SKIN.id, name: DEFAULT_SKIN.name, meta: 'procedural notes', skin: DEFAULT_SKIN },
        ...state.skins.map(skin => ({
            id: skin.id,
            name: skin.name,
            meta: skinMeta(skin),
            skin,
        })),
    ];

    for (const entry of entries) {
        const item = document.createElement('li');
        item.className = 'skin-item';
        if (state.activeSkinId === entry.id) item.classList.add('active');

        const dot = document.createElement('span');
        dot.className = 'skin-dot';

        const info = document.createElement('div');
        info.className = 'skin-info';

        const name = document.createElement('div');
        name.className = 'skin-name';
        name.textContent = entry.name;

        const meta = document.createElement('div');
        meta.className = 'skin-meta';
        meta.textContent = entry.meta;

        info.append(name, meta);
        item.append(dot, info);
        item.addEventListener('click', () => {
            state.activeSkinId = entry.id;
            renderSkins();
        });

        dom.skinList.append(item);
    }
}

function skinMeta(skin) {
    if (skin.isDefault) return 'procedural notes';

    const counts = [...skin.configs.keys()].sort((a, b) => a - b).map(count => `${count}K`);
    const parts = [];

    if (skin.author) parts.push(skin.author);
    if (counts.length) parts.push(counts.join(', '));
    parts.push(skin.hasImages ? 'with sprites' : 'no sprites');

    return parts.join(' · ');
}

async function importSkinFile(file) {
    try {
        setStatus(`Loading skin ${file.name}…`);
        const zip = await readZip(file);
        const skin = await loadSkin(zip, file.name);

        state.skins.push(skin);
        state.activeSkinId = skin.id;
        renderSkins();
        setStatus(`Skin "${skin.name}" loaded.`);
    } catch (error) {
        console.warn(`Could not load skin ${file.name}`, error);
        setStatus(`Skin could not be loaded: ${error.message}`);
    }
}

// --------------------------------------------------------------- importing

async function handleFiles(files) {
    const list = [...files];
    if (!list.length) return;

    const skins = list.filter(file => file.name.toLowerCase().endsWith('.osk'));
    const charts = list.filter(file => !file.name.toLowerCase().endsWith('.osk'));

    for (const file of skins)
        await importSkinFile(file);

    if (charts.length)
        await importCharts(charts);
}

async function importCharts(files) {
    setStatus('Reading files…');

    let imported = 0;
    let skipped = 0;
    let failed = 0;

    for (const file of files) {
        const name = file.name.toLowerCase();

        try {
            if (name.endsWith('.osz') || name.endsWith('.zip')) {
                const zip = await readZip(file);
                const osuEntries = zip.names.filter(entry => entry.toLowerCase().endsWith('.osu'));

                if (!osuEntries.length) {
                    failed++;
                    continue;
                }

                for (const entry of osuEntries) {
                    const map = parseChart(await zip.readText(entry), entry.split('/').pop());

                    if (!admit(map)) {
                        skipped++;
                        continue;
                    }

                    addBeatmap(map, zip, file.name);
                    imported++;
                }
            } else if (name.endsWith('.osu')) {
                const map = parseChart(await file.text(), file.name);

                if (!admit(map)) {
                    skipped++;
                    continue;
                }

                addBeatmap(map, null, file.name);
                imported++;
            } else {
                skipped++;
            }
        } catch (error) {
            console.warn(`Could not import ${file.name}`, error);
            failed++;
        }
    }

    const parts = [];

    if (imported) parts.push(`Imported ${imported} chart${imported === 1 ? '' : 's'}`);
    if (skipped) parts.push(`${skipped} skipped (non-mania or unsupported)`);
    if (failed) parts.push(`${failed} unreadable`);

    setStatus(parts.join(' · ') || 'Nothing to import.');
    renderLibrary();

    return { imported, skipped, failed };
}

// ---------------------------------------------------------------- featured

async function featuredBlob(id) {
    const url = `https://osu.direct/api/d/${id}`;
    let cache = null;

    try {
        if ('caches' in window) {
            cache = await caches.open(FEATURED_CACHE);
            const cached = await cache.match(url);
            if (cached?.ok) return cached.blob();
        }
    } catch (error) {
        console.warn('Featured map cache unavailable', error);
        cache = null;
    }

    const response = await fetch(url);

    if (!response.ok) throw new Error(`the mirror returned ${response.status}`);

    if (cache) {
        try {
            await cache.put(url, response.clone());
        } catch (error) {
            console.warn('Featured map could not be cached', error);
        }
    }

    return response.blob();
}

async function seedFeatured() {
    if (featuredStarted || state.beatmaps.length) return;

    featuredStarted = true;
    let imported = 0;
    let failures = 0;

    for (const [index, featured] of FEATURED_MAPS.entries()) {
        try {
            setStatus(`Loading featured maps… ${index + 1}/${FEATURED_MAPS.length}`);
            const blob = await featuredBlob(featured.id);
            if (blob.size < 1024) throw new Error('the download was empty');

            const file = new File([blob], `${featured.title}.osz`, { type: 'application/zip' });
            const result = await importCharts([file]);
            imported += result.imported;
        } catch (error) {
            failures++;
            console.warn(`Featured map ${featured.title} could not be loaded`, error);
        }
    }

    if (imported) {
        setStatus(`Featured maps ready — ${imported} chart${imported === 1 ? '' : 's'} added. Download more above.`);
    } else if (!state.beatmaps.length) {
        setStatus('Featured maps could not load. Search above or drop an .osz.', true);
    } else if (failures) {
        setStatus('Some featured maps could not load; your imported charts are ready.');
    }
}

function parseChart(text, name) {
    const match = String(text).match(/^\s*Mode\s*:\s*(\d+)/im);
    const mode = match ? Number.parseInt(match[1], 10) : 0;

    if (mode === 0) return parseOsuStandard(text, name);
    return parseOsu(text, name);
}

function admit(map) {
    if (!map.hits.length) return false;
    if (map.mode === 0) return true;

    // Mania only supports key counts this port can bind keys to.
    return map.isMania && map.keyCount <= 10;
}

function addBeatmap(map, zip, source) {
    const key = `${map.artist}|${map.title}|${map.version}|${map.mode === 0 ? 'std' : map.keyCount}`;

    if (state.beatmaps.some(entry => entry.key === key))
        return;

    state.beatmaps.push({
        id: uid(),
        key,
        map,
        zip,
        source,
    });
}

// ---------------------------------------------------------------- library

function beatmapSets() {
    const sets = new Map();

    for (const entry of state.beatmaps) {
        const map = entry.map;
        const key = `${map.artist}|${map.title}|${map.creator}`.toLowerCase();

        if (!sets.has(key)) sets.set(key, []);
        sets.get(key).push(entry);
    }

    return [...sets.values()];
}

function selectRow(item) {
    for (const row of dom.list.children)
        row.classList.toggle('selected', row === item);
}

function renderLibrary() {
    dom.list.replaceChildren();

    if (!state.beatmaps.length) {
        const empty = document.createElement('li');
        empty.className = 'empty-library';
        empty.textContent = 'No charts yet. Featured maps load automatically; you can also drop an .osz or search above.';
        dom.list.append(empty);
    }

    const rate = resolveMods(state.mods, state.rates).rate;

    for (const entries of beatmapSets()) {
        const sorted = [...entries].sort((a, b) => (starRatingFor(a, rate) ?? 0) - (starRatingFor(b, rate) ?? 0));
        const first = sorted[0];
        const map = first.map;
        const selected = sorted.find(entry => entry.id === state.selectedId) ?? null;

        const item = document.createElement('li');
        item.className = 'beatmap';
        if (selected) item.classList.add('selected');

        const info = document.createElement('div');
        info.className = 'beatmap-info';

        const title = document.createElement('div');
        title.className = 'beatmap-title';
        title.textContent = map.title || map.fileName;

        const sub = document.createElement('div');
        sub.className = 'beatmap-sub';
        sub.textContent = `${map.artist} · ${map.creator}${sorted.length > 1 ? ` · ${sorted.length} difficulties` : ''}`;

        info.append(title, sub);

        let select = null;

        if (sorted.length > 1) {
            // One beatmapset with several difficulties gets a dropdown instead of chips.
            select = document.createElement('select');
            select.className = 'beatmap-select';
            select.setAttribute('aria-label', `${map.title} difficulties`);

            for (const entry of sorted) {
                const option = document.createElement('option');
                const star = starRatingFor(entry, rate);
                option.value = entry.id;
                option.textContent = `${entry.map.version} · ${modeTag(entry.map)}${star === null ? '' : ` · ★ ${star.toFixed(2)}`}`;
                select.append(option);
            }

            select.value = (selected ?? first).id;
            select.addEventListener('click', event => event.stopPropagation());
            select.addEventListener('change', () => {
                state.selectedId = select.value;
                selectRow(item);
            });

            item.append(info, select);
        } else {
            const tags = document.createElement('div');
            tags.className = 'beatmap-tags';
            const star = starRatingFor(first, rate);

            tags.append(
                chip(modeTag(map)),
                chip(map.version),
                ...(star === null ? [] : [chip(`★ ${star.toFixed(2)}`)]),
                chip(`${map.noteCount} notes`),
            );

            item.append(info, tags);
        }

        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'btn small primary';
        play.textContent = 'Play';
        play.addEventListener('click', event => {
            event.stopPropagation();
            playBeatmap(select ? select.value : first.id);
        });

        item.append(play);

        item.addEventListener('click', () => {
            state.selectedId = select ? select.value : first.id;
            selectRow(item);
        });
        item.addEventListener('dblclick', () => playBeatmap(select ? select.value : first.id));

        dom.list.append(item);
    }

    dom.count.textContent = `${state.beatmaps.length} chart${state.beatmaps.length === 1 ? '' : 's'}`;
}

function chip(text) {
    const span = document.createElement('span');
    span.className = 'chip';
    span.textContent = text;
    return span;
}

// --------------------------------------------------------------- gameplay

async function playBeatmap(id) {
    const entry = state.beatmaps.find(candidate => candidate.id === id);
    if (!entry) return;

    destroyGame();
    if (calibration.active) stopCalibration();

    state.selectedId = id;
    state.currentId = id;

    audio.ensure();
    audio.setVolume(state.settings.volume);

    setScreen('game');
    resetHud(entry);

    const isStandard = entry.map.mode === 0;
    document.body.classList.toggle('mode-std', isStandard);

    const GameClass = isStandard ? OsuGame : ManiaGame;

    const game = new GameClass({
        canvas: dom.stage,
        beatmap: entry.map,
        audio,
        settings: state.settings,
        skin: isStandard ? null : activeSkin(),
        mods: resolveMods(state.mods, state.rates),
        keybinds: isStandard ? null : state.keybinds,
        onEvent: handleGameEvent,
    });

    state.game = game;

    await loadAssets(entry, game);

    // The player may have quit while assets were loading.
    if (state.game !== game) return;

    game.start();
}

async function loadAssets(entry, game) {
    const map = entry.map;

    if (!entry.zip) {
        setStatus('Chart loaded without audio. Drop the .osz to get the song too.');
        return;
    }

    if (map.backgroundFile) {
        try {
            const bytes = await entry.zip.readBytes(map.backgroundFile);
            const url = URL.createObjectURL(new Blob([bytes]));
            const image = new Image();
            image.src = url;
            game.setBackground(image);
        } catch (error) {
            console.warn('Background could not be loaded', error);
        }
    }

    try {
        let audioName = map.audioFile;

        if (!audioName || !entry.zip.has(audioName)) {
            audioName = entry.zip.names.find(name =>
                AUDIO_EXTENSIONS.some(extension => name.toLowerCase().endsWith(`.${extension}`)),
            );
        }

        if (!audioName) return;

        const bytes = await entry.zip.readBytes(audioName);
        game.setMusic(await audio.decode(bytes));
    } catch (error) {
        console.warn('Audio could not be decoded', error);
        setStatus('Audio could not be decoded for this map — playing silently.');
    }
}

function destroyGame() {
    if (state.game) {
        state.game.destroy();
        state.game = null;
    }
    showPauseOverlay(false);
}

function resetHud(entry) {
    const map = entry.map;
    const mods = resolveMods(state.mods, state.rates);
    const star = starRatingFor(entry, mods.rate);
    const mode = map.mode === 0
        ? `osu!std · AR ${map.approachRate.toFixed(1)} · CS ${map.circleSize.toFixed(1)}`
        : `${map.keyCount}K · ${map.version}`;

    dom.title.textContent = map.title || map.fileName;
    dom.artist.textContent = map.artist;
    dom.diff.textContent = `${mode} · OD ${map.overallDifficulty}${star === null ? '' : ` · ★ ${star.toFixed(2)}`}${mods.ids.length ? ` · +${mods.ids.join('')}` : ''}`;
    dom.score.textContent = '0';
    dom.accuracy.textContent = '100.00%';
    dom.combo.textContent = '';
    dom.combo.classList.remove('visible');
    dom.judgement.textContent = '';
    dom.judgement.classList.remove('pop');
    dom.progress.style.width = '0%';
    dom.health.style.width = '100%';
    dom.vignette.style.opacity = '0';
    dom.vignette.classList.remove('critical');
}

function handleGameEvent(event) {
    switch (event.type) {
        case 'hud':
            updateHud(event);
            break;

        case 'judgement':
            showJudgement(event);
            break;

        case 'finish':
        case 'fail':
            showResults(event.summary);
            break;

        case 'pause':
            togglePause();
            break;

        case 'paused':
            showPauseOverlay(true);
            break;

        case 'resumed':
            showPauseOverlay(false);
            break;
    }
}

function updateHud({ score, combo, accuracy, progress, health }) {
    const healthRatio = clamp01(health);

    dom.score.textContent = score.toLocaleString();
    dom.accuracy.textContent = `${accuracy.toFixed(2)}%`;
    dom.combo.textContent = combo > 1 ? String(combo) : '';
    dom.combo.classList.toggle('visible', combo > 1);
    dom.progress.style.width = `${(progress * 100).toFixed(2)}%`;
    dom.health.style.width = `${(healthRatio * 100).toFixed(2)}%`;

    // Red edges ramp in below 35% health and pulse in the last 15%.
    const danger = Math.max(0, Math.min(1, (0.35 - healthRatio) / 0.35));
    dom.vignette.style.opacity = (danger * 0.9).toFixed(2);
    dom.vignette.classList.toggle('critical', healthRatio > 0 && healthRatio <= 0.15);
}

const clamp01 = value => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1));

function showJudgement({ label, colour }) {
    dom.judgement.textContent = label;
    dom.judgement.style.color = colour;

    dom.judgement.classList.remove('pop');
    void dom.judgement.offsetWidth;
    dom.judgement.classList.add('pop');
}

function togglePause() {
    const game = state.game;
    if (!game || game.finished) return;

    if (game.paused) game.resume();
    else game.pause();
}

function showPauseOverlay(visible) {
    dom.pauseOverlay.classList.toggle('visible', visible);
}

// ---------------------------------------------------------------- results

function showResults(summary) {
    const entry = state.beatmaps.find(candidate => candidate.id === state.currentId);

    if (entry) {
        const map = entry.map;
        const star = starRatingFor(entry, resolveMods(state.mods, state.rates).rate);
        const mode = map.mode === 0
            ? `osu!std · AR ${map.approachRate.toFixed(1)} · CS ${map.circleSize.toFixed(1)}`
            : `${map.keyCount}K · ${map.version}`;

        $('#res-title').textContent = map.title || map.fileName;
        $('#res-diff').textContent = `${mode} · OD ${map.overallDifficulty}${star === null ? '' : ` · ★ ${star.toFixed(2)}`} · ${map.noteCount} notes`;
    }

    const judgementSet = summary.mode === 'osu' ? STD_JUDGEMENTS : JUDGEMENTS;
    const order = summary.mode === 'osu' ? STD_JUDGEMENT_ORDER : JUDGEMENT_ORDER;

    const grade = $('#res-grade');
    const failed = summary.failed === true;
    grade.textContent = failed ? 'F' : summary.grade;
    grade.dataset.grade = failed ? 'F' : summary.grade;
    $('#res-failed').hidden = !failed;

    $('#res-score').textContent = summary.score.toLocaleString();
    $('#res-acc').textContent = `${summary.accuracy.toFixed(2)}%`;
    $('#res-combo').textContent = `Max combo ${summary.maxCombo} · ${summary.totalJudgements} judgements`;

    $('#res-mods').textContent = summary.mods?.length
        ? `+${summary.mods.join('')} · ${summary.rate.toFixed(2)}x rate · ${summary.scoreMultiplier.toFixed(2)}x score`
        : 'No mods';

    const counts = $('#res-counts');
    counts.replaceChildren();

    for (const key of order) {
        const row = document.createElement('div');
        row.className = 'count-row';

        const label = document.createElement('span');
        label.textContent = judgementSet[key].label;
        label.style.color = judgementSet[key].colour;

        const value = document.createElement('b');
        value.textContent = String(summary.counts[key]);

        row.append(label, value);
        counts.append(row);
    }

    setScreen('results');
}

function retry() {
    if (state.currentId) playBeatmap(state.currentId);
}

function backToMenu() {
    destroyGame();
    document.body.classList.remove('mode-std');
    setScreen('menu');
    renderLibrary();
}

// ---------------------------------------------------------------- settings

function bindSettings() {
    dom.speed.value = String(state.settings.scrollSpeed);
    dom.speedValue.textContent = String(state.settings.scrollSpeed);
    dom.dim.value = String(state.settings.backgroundDim);
    dom.dimValue.textContent = `${state.settings.backgroundDim}%`;
    dom.volume.value = String(state.settings.volume);
    dom.volumeValue.textContent = `${state.settings.volume}%`;
    dom.auto.checked = state.settings.auto;
    dom.clicks.checked = state.settings.clicks;
    audio.setClicksEnabled(state.settings.clicks);
    setOffset(state.settings.offset, { persist: false });

    dom.speed.addEventListener('input', () => {
        state.settings.scrollSpeed = Number.parseInt(dom.speed.value, 10);
        dom.speedValue.textContent = String(state.settings.scrollSpeed);
        saveSettings();
        state.game?.layout();
    });

    dom.dim.addEventListener('input', () => {
        state.settings.backgroundDim = Number.parseInt(dom.dim.value, 10);
        dom.dimValue.textContent = `${state.settings.backgroundDim}%`;
        saveSettings();
    });

    dom.volume.addEventListener('input', () => {
        state.settings.volume = Number.parseInt(dom.volume.value, 10);
        dom.volumeValue.textContent = `${state.settings.volume}%`;
        saveSettings();
        audio.setVolume(state.settings.volume);
    });

    dom.auto.addEventListener('change', () => {
        state.settings.auto = dom.auto.checked;
        saveSettings();
    });

    dom.clicks.addEventListener('change', () => {
        state.settings.clicks = dom.clicks.checked;
        saveSettings();
        audio.setClicksEnabled(state.settings.clicks);
    });

    dom.offset.addEventListener('input', () => setOffset(dom.offset.value));

    dom.calibrate.addEventListener('click', startCalibration);
    dom.calibrateTap.addEventListener('click', registerCalibrationTap);
    dom.calibrateApply.addEventListener('click', applyCalibration);
}

function bindKeyEditor() {
    dom.keysCount.replaceChildren();

    for (const count of SUPPORTED_KEY_COUNTS) {
        const option = document.createElement('option');
        option.value = String(count);
        option.textContent = `${count}K`;
        dom.keysCount.append(option);
    }

    dom.keysCount.addEventListener('change', () => {
        cancelKeyCapture();
        state.keyEditorCount = Number.parseInt(dom.keysCount.value, 10);
        renderKeyEditor();
    });

    $('#btn-keys-reset').addEventListener('click', () => {
        cancelKeyCapture();
        resetKeybinds(state.keybinds, state.keyEditorCount);
        saveKeybinds(state.keybinds);
        renderKeyEditor();
    });

    // Capture phase so a new binding never reaches gameplay handlers.
    window.addEventListener('keydown', handleCaptureKey, true);
}

function bindSkins() {
    $('#btn-skin-import').addEventListener('click', () => dom.skinInput.click());

    dom.skinInput.addEventListener('change', async () => {
        const file = dom.skinInput.files?.[0];
        dom.skinInput.value = '';
        if (file) await importSkinFile(file);
    });
}

// ------------------------------------------------------------ online beatmaps

let onlineSets = [];
let onlineSearchToken = 0;

const ONLINE_MODE_IDS = new Map([['osu', 0], ['taiko', 1], ['fruits', 2], ['mania', 3]]);

function bindOnline() {
    dom.onlineForm.addEventListener('submit', event => {
        event.preventDefault();
        searchOnline();
    });

    dom.onlineMode.addEventListener('change', () => {
        if (onlineSets.length) renderOnlineResults(onlineSets, dom.onlineMode.value);
    });
}

function setOnlineStatus(message, error = false) {
    dom.onlineStatus.textContent = message;
    dom.onlineStatus.classList.toggle('error', error);
}

async function searchOnline() {
    const query = dom.onlineQuery.value.trim();

    if (!query) {
        onlineSearchToken++;
        onlineSets = [];
        dom.onlineSubmit.disabled = false;
        dom.onlineResults.replaceChildren();
        setOnlineStatus('Type a song, artist or mapper to search.', true);
        dom.onlineQuery.focus();
        return;
    }

    const token = ++onlineSearchToken;
    onlineSets = [];
    dom.onlineSubmit.disabled = true;
    dom.onlineResults.replaceChildren();
    setOnlineStatus('Searching osu! beatmaps…');

    try {
        const response = await fetch(`https://osu.direct/api/v2/search?q=${encodeURIComponent(query)}&limit=50`);

        if (!response.ok) throw new Error(`search returned ${response.status}`);

        const data = await response.json();
        if (token !== onlineSearchToken) return;

        onlineSets = Array.isArray(data) ? data : [];
        renderOnlineResults(onlineSets, dom.onlineMode.value);
    } catch (error) {
        if (token !== onlineSearchToken) return;

        console.warn('Online beatmap search failed', error);
        setOnlineStatus(`Search failed: ${error.message}. Check your connection and try again.`, true);
    } finally {
        if (token === onlineSearchToken) dom.onlineSubmit.disabled = false;
    }
}

function modeIdsForSet(set) {
    return new Set((set.beatmaps ?? []).map(beatmap => beatmap.mode_int ?? ONLINE_MODE_IDS.get(beatmap.mode)));
}

function renderOnlineResults(sets, mode) {
    dom.onlineResults.replaceChildren();

    const results = sets
        .filter(set => set.id && !set.nsfw && !set.deleted_at)
        .filter(set => {
            const modes = modeIdsForSet(set);
            if (mode === 'mania') return modes.has(3);
            if (mode === 'std') return modes.has(0);
            return modes.has(3) || modes.has(0);
        })
        .slice(0, 24);

    if (!results.length) {
        const empty = document.createElement('li');
        empty.className = 'empty-library';
        empty.textContent = 'No playable mapsets matched. Try another search or mode.';
        dom.onlineResults.append(empty);
        setOnlineStatus('No playable mapsets matched that search.', true);
        return;
    }

    for (const set of results) dom.onlineResults.append(onlineResultItem(set));

    setOnlineStatus(`${results.length} mapset${results.length === 1 ? '' : 's'} found — download a .osz below.`);
}

function onlineResultItem(set) {
    const item = document.createElement('li');
    item.className = 'online-item';

    const info = document.createElement('div');
    info.className = 'online-info';

    const title = document.createElement('div');
    title.className = 'online-title';
    title.textContent = set.title || 'Untitled';

    const sub = document.createElement('div');
    sub.className = 'online-sub';
    sub.textContent = `${set.artist || 'Unknown artist'} · ${set.creator || 'Unknown mapper'}`;

    const tags = document.createElement('div');
    tags.className = 'online-tags';
    tags.append(chip(set.status || 'unranked'));

    const modes = modeIdsForSet(set);
    if (modes.has(3)) tags.append(chip('Mania'));
    if (modes.has(0)) tags.append(chip('Std'));
    tags.append(chip(`${set.beatmaps?.length ?? 0} diff`));

    info.append(title, sub, tags);

    const actions = document.createElement('div');
    actions.className = 'online-actions';

    const open = document.createElement('a');
    open.className = 'btn small';
    open.href = `https://osu.ppy.sh/beatmapsets/${set.id}`;
    open.target = '_blank';
    open.rel = 'noreferrer';
    open.textContent = 'osu!';
    open.title = 'Open this mapset on osu.ppy.sh';

    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'btn small primary';
    download.textContent = 'Download';
    download.title = 'Download the .osz from osu.direct';
    download.addEventListener('click', () => downloadOnlineSet(set, download));

    actions.append(open, download);
    item.append(info, actions);
    return item;
}

function onlineFileName(set) {
    const base = `${set.artist || 'beatmap'} - ${set.title || set.id}`
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);

    return `${base || `beatmap-${set.id}`}.osz`;
}

async function downloadOnlineSet(set, button) {
    if (button.disabled) return;

    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Wait…';
    setOnlineStatus(`Downloading ${set.artist || 'mapset'} — ${set.title || set.id}…`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);

    try {
        const response = await fetch(`https://osu.direct/api/d/${set.id}`, { signal: controller.signal });

        if (!response.ok) throw new Error(`download returned ${response.status}`);

        const blob = await response.blob();
        if (blob.size < 1024) throw new Error('the download was empty');

        const file = new File([blob], onlineFileName(set), { type: 'application/zip' });
        const result = await importCharts([file]);

        if (result.imported) {
            setOnlineStatus(`Added ${result.imported} chart${result.imported === 1 ? '' : 's'} from “${set.title || set.id}”.`);
        } else {
            setOnlineStatus('Downloaded, but it contained no playable mania or standard charts.', true);
        }
    } catch (error) {
        console.warn('Online beatmap download failed', error);
        const reason = error.name === 'AbortError' ? 'the download timed out' : error.message;
        setOnlineStatus(`Download failed: ${reason}. Use the osu! button to open it on the website.`, true);
    } finally {
        clearTimeout(timer);
        button.disabled = false;
        button.textContent = label;
    }
}

// -------------------------------------------------------------- event wiring

function bindEvents() {
    $('#btn-browse').addEventListener('click', () => dom.fileInput.click());
    $('#btn-pause').addEventListener('click', () => state.game?.pause());

    dom.fileInput.addEventListener('change', () => {
        handleFiles(dom.fileInput.files);
        dom.fileInput.value = '';
    });

    document.addEventListener('dragover', event => {
        if (!event.dataTransfer?.types.includes('Files')) return;
        event.preventDefault();
        dom.dropZone.classList.add('dragging');
    });

    document.addEventListener('dragleave', event => {
        if (event.relatedTarget === null) dom.dropZone.classList.remove('dragging');
    });

    document.addEventListener('drop', event => {
        if (!event.dataTransfer?.files?.length) return;
        event.preventDefault();
        dom.dropZone.classList.remove('dragging');
        handleFiles(event.dataTransfer.files);
    });

    $('#btn-resume').addEventListener('click', () => state.game?.resume());
    $('#btn-quit').addEventListener('click', backToMenu);
    $('#btn-retry').addEventListener('click', retry);
    $('#btn-back').addEventListener('click', backToMenu);

    window.addEventListener('keydown', event => {
        if (event.code !== 'Escape') return;
        if ($('#screen-results').classList.contains('active')) backToMenu();
    });

    // Pause when the tab is hidden so the song does not run on without input.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) return;
        state.game?.pause();
        if (calibration.active) stopCalibration();
    });

    document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
        if (calibration.active) stopCalibration();
    }));
}

bindTabs();
bindSettings();
bindKeyEditor();
bindSkins();
bindOnline();
bindEvents();
renderMods();
renderKeyEditor();
renderSkins();
renderLibrary();
seedFeatured();
