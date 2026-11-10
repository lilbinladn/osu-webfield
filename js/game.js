// osu!mania gameplay: judging, scoring and canvas rendering.
// Scoring follows the ScoreV2 split used by modern osu!mania
// (70% combo progress, 30% accuracy), with hit windows from ManiaHitWindows.

import { computeHitWindows } from './beatmap.js';
import { KEY_LAYOUTS, keyLabel } from './keybinds.js';
import { buildColumnPermutation } from './mods.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export { KEY_LAYOUTS };

export const JUDGEMENTS = {
    perfect: { label: 'MAX', value: 320, colour: '#8fe8ff' },
    great: { label: '300', value: 300, colour: '#8ef29a' },
    good: { label: '200', value: 200, colour: '#ffe066' },
    ok: { label: '100', value: 100, colour: '#ffb066' },
    meh: { label: '50', value: 50, colour: '#ff8b8b' },
    miss: { label: 'MISS', value: 0, colour: '#ff5c72' },
};

export const JUDGEMENT_ORDER = ['perfect', 'great', 'good', 'ok', 'meh', 'miss'];

const LIGHT_TEXT = '#e6ecff';
const BLUE_TEXT = '#5b90ff';
const SPECIAL_TEXT = '#ff7cc8';

const DEFAULT_HIT_POSITION = 402;

function defaultColumnColour(column, keyCount) {
    const isSpecial = keyCount % 2 === 1 && column === (keyCount - 1) / 2;
    if (isSpecial) return SPECIAL_TEXT;
    return column % 2 === 0 ? BLUE_TEXT : LIGHT_TEXT;
}

function hexToRgba(hex, alpha) {
    const value = String(hex).replace('#', '');
    const r = Number.parseInt(value.slice(0, 2), 16);
    const g = Number.parseInt(value.slice(2, 4), 16);
    const b = Number.parseInt(value.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
}

function numericArray(values, length, fallback, { positive = false } = {}) {
    if (length <= 0) return [];

    if (!Array.isArray(values) || values.length < length)
        return new Array(length).fill(fallback);

    const result = values.slice(0, length);

    for (const value of result) {
        if (!Number.isFinite(value) || value < 0 || (positive && value <= 0))
            return new Array(length).fill(fallback);
    }

    return result;
}

export function gradeFor(accuracy) {
    if (accuracy >= 100) return 'SS';
    if (accuracy >= 95) return 'S';
    if (accuracy >= 90) return 'A';
    if (accuracy >= 80) return 'B';
    if (accuracy >= 70) return 'C';
    return 'D';
}

export class ManiaGame {
    constructor({ canvas, beatmap, audio, settings, skin, mods, keybinds, onEvent }) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.beatmap = beatmap;
        this.audio = audio;
        this.settings = settings;
        this.skin = skin ?? null;
        this.mods = mods ?? {
            ids: [],
            acronyms: [],
            rate: 1,
            windowMultiplier: 1,
            scoreMultiplier: 1,
            hidden: false,
            mirror: false,
            random: false,
        };
        this.onEvent = onEvent ?? (() => {});

        this.rate = this.mods.rate ?? 1;
        this.offsetSeconds = (Number(settings.offset) || 0) / 1000;
        this.hidden = !!this.mods.hidden;

        // ManiaHealthProcessor: mania never drains passively; only judgements
        // move health (and only misses/mehs can take it away).
        this.drainRate = clamp(Number(beatmap.drainRate) || 0, 0, 10);
        this.health = 1;
        // The built-in default skin uses the classic osu!mania look instead of sprites.
        this.defaultLook = !!this.skin?.isDefault;
        this.comboChangedAt = 0;

        // ManiaHitWindows: windows scale with the track rate (so real-time
        // tolerance stays constant) and inversely with HR/EZ multipliers.
        this.windows = computeHitWindows(beatmap.overallDifficulty, {
            speedMultiplier: this.rate,
            difficultyMultiplier: this.mods.windowMultiplier ?? 1,
        });

        const keyCount = beatmap.keyCount;
        this.skinConfig = this.skin?.configFor?.(keyCount) ?? null;
        this.keyCodes = [...(keybinds?.[keyCount] ?? KEY_LAYOUTS[keyCount] ?? KEY_LAYOUTS[4])];
        this.keyToColumn = new Map(this.keyCodes.map((code, index) => [code, index]));

        const permutation = buildColumnPermutation(keyCount, this.mods);

        this.notes = beatmap.hits.map(hit => ({
            column: permutation[hit.column],
            startTime: hit.time,
            endTime: hit.endTime,
            isHold: hit.endTime !== null,
            headJudged: false,
            tailJudged: false,
            headResult: null,
            tailResult: null,
            holding: false,
        }));

        this.counts = { perfect: 0, great: 0, good: 0, ok: 0, meh: 0, miss: 0 };
        this.totalJudgements = Math.max(1, beatmap.maxJudgements);
        this.maxComboSum = this.totalJudgements * (this.totalJudgements + 1) / 2;

        this.score = 0;
        this.combo = 0;
        this.maxCombo = 0;
        this.accuracy = 100;
        this.hitSum = 0;
        this.progressSum = 0;
        this.judged = 0;

        this.pressed = new Array(keyCount).fill(false);
        this.holdByColumn = new Array(keyCount).fill(null);
        this.flashes = [];

        this.running = false;
        this.paused = false;
        this.finished = false;
        this.failed = false;
        this.background = null;

        this.startCtxTime = 0;
        this.startSongTime = 0;
        this.lastHudAt = 0;

        this._onKeyDown = event => this.handleKeyDown(event);
        this._onKeyUp = event => this.handleKeyUp(event);
        this._onResize = () => this.layout();
        this._onBlur = () => {
            if (this.running && !this.paused && !this.finished) this.pause();
        };

        this.frame = this.frame.bind(this);
        this.layout();
    }

    setBackground(image) {
        this.background = image;
    }

    setMusic(buffer) {
        this.musicBuffer = buffer;
    }

    start() {
        this.audio.ensure();
        this.audio.setVolume(this.settings.volume);

        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
        window.addEventListener('resize', this._onResize);
        window.addEventListener('blur', this._onBlur);

        const leadIn = 2600;
        this.startSongTime = Math.max(0, this.beatmap.firstTime - leadIn);
        this.startCtxTime = this.audio.now() + 0.35;

        if (this.musicBuffer) {
            this.audio.scheduleMusic(
                this.musicBuffer,
                this.startSongTime / 1000,
                this.startCtxTime,
                this.rate,
            );
        }

        this.layout();
        this.running = true;
        this.emitHud(true);
        this.raf = requestAnimationFrame(this.frame);
    }

    // Song position in map time; the rate mods scale how fast it advances.
    songTime() {
        return this.startSongTime + (this.audio.now() - this.startCtxTime) * 1000 * this.rate;
    }

    // Universal offset: positive values shift judging later in real time.
    judgeTime() {
        return this.songTime() - this.offsetSeconds * 1000;
    }

    emit(event) {
        this.onEvent(event);
    }

    emitHud(force = false) {
        const now = performance.now();
        if (!force && now - this.lastHudAt < 90) return;
        this.lastHudAt = now;

        this.emit({
            type: 'hud',
            score: this.score,
            combo: this.combo,
            accuracy: this.accuracy,
            progress: this.progress(),
            health: this.health,
        });
    }

    progress() {
        const span = Math.max(1, this.beatmap.lastTime - this.beatmap.firstTime);
        return clamp((this.songTime() - this.beatmap.firstTime) / span, 0, 1);
    }

    frame() {
        if (!this.running) return;

        const now = this.songTime();

        if (!this.paused) {
            this.update(this.judgeTime());
            this.emitHud();
        }

        this.render(now);

        if (this.running) this.raf = requestAnimationFrame(this.frame);
    }

    update(now) {
        const missWindow = this.windows.miss;

        for (const note of this.notes) {
            if (this.finished) break;

            if (!note.headJudged) {
                if (this.settings.auto) {
                    if (now >= note.startTime) this.registerHead(note, 'perfect', 0);
                } else if (now > note.startTime + missWindow) {
                    this.registerHead(note, 'miss', missWindow);
                }
            }

            if (!note.isHold || !note.headJudged || note.tailJudged) continue;

            if (this.settings.auto) {
                if (now >= note.endTime) this.registerTail(note, 'perfect', 0);
                continue;
            }

            if (note.holding && now >= note.endTime) {
                this.registerTail(note, 'perfect', 0);
            } else if (!note.holding && now > note.endTime + missWindow) {
                this.registerTail(note, 'miss', missWindow);
            }
        }

        if (this.settings.auto) this.updateAutoPresses(now);

        if (!this.finished && now > this.beatmap.lastTime + 1800)
            this.finish();
    }

    updateAutoPresses(now) {
        for (let column = 0; column < this.keyCodes.length; column++) {
            this.pressed[column] = this.notes.some(note => {
                if (note.column !== column) return false;
                const end = note.isHold ? note.endTime : note.startTime + 50;
                return now >= note.startTime - 15 && now <= end;
            });
        }
    }

    resultFor(absError) {
        const windows = this.windows;
        if (absError <= windows.perfect) return 'perfect';
        if (absError <= windows.great) return 'great';
        if (absError <= windows.good) return 'good';
        if (absError <= windows.ok) return 'ok';
        if (absError <= windows.meh) return 'meh';
        return 'miss';
    }

    // Mirrors ManiaHealthProcessor.GetHealthIncreaseFor for a non-hold
    // HeadNote/TailNote at the beatmap's drain rate.
    healthIncrease(result) {
        const drain = this.drainRate;

        switch (result) {
            case 'perfect': return 0.0055 - drain * 0.0005;
            case 'great': return 0.005 - drain * 0.0005;
            case 'good': return 0.004 - drain * 0.0004;
            case 'ok': return 0;
            case 'meh': return -(drain + 1) * 0.0016;
            default: return -(drain + 1) * 0.00375;
        }
    }

    applyHealth(result) {
        if (this.settings.auto) return false;

        this.health = clamp(this.health + this.healthIncrease(result), 0, 1);
        return this.health <= 0;
    }

    register(result) {
        if (this.finished) return;

        const fatal = this.applyHealth(result);

        this.counts[result]++;
        this.judged++;
        this.hitSum += JUDGEMENTS[result].value;

        if (result === 'miss') {
            this.combo = 0;
        } else {
            this.combo++;
            this.maxCombo = Math.max(this.maxCombo, this.combo);
        }

        this.progressSum += this.combo;
        this.comboChangedAt = performance.now();

        this.accuracy = this.judged ? this.hitSum / (320 * this.judged) * 100 : 100;

        const baseScore = 300000 * (this.hitSum / (320 * this.totalJudgements))
            + 700000 * (this.progressSum / this.maxComboSum);

        this.score = Math.round(baseScore * (this.mods.scoreMultiplier ?? 1));

        this.emitHud(true);
        if (fatal) this.fail();
    }

    emitJudgement(result) {
        this.emit({
            type: 'judgement',
            result,
            label: JUDGEMENTS[result].label,
            colour: JUDGEMENTS[result].colour,
            combo: this.combo,
        });
    }

    registerHead(note, result, error) {
        note.headJudged = true;
        note.headResult = result;

        if (result === 'miss') {
            this.audio.miss();
        } else {
            this.audio.hitNote(note.column);
            this.flash(note.column, result);
        }

        this.register(result);
        this.emitJudgement(result);

        if (note.isHold) {
            if (result === 'miss') {
                this.registerTail(note, 'miss', error);
            } else {
                note.holding = true;
                this.holdByColumn[note.column] = note;
            }
        }
    }

    registerTail(note, result, error) {
        if (note.tailJudged) return;

        note.tailJudged = true;
        note.holding = false;
        note.tailResult = result;

        if (this.holdByColumn[note.column] === note)
            this.holdByColumn[note.column] = null;

        if (result === 'miss') {
            this.audio.miss();
            this.flash(note.column, 'miss');
        }

        this.register(result);
        this.emitJudgement(result);
    }

    flash(column, result) {
        this.flashes.push({
            column,
            result,
            at: performance.now(),
            colour: this.defaultLook ? '#ffffff' : JUDGEMENTS[result].colour,
        });
    }

    handleKeyDown(event) {
        if (event.code === 'Escape') {
            this.emit({ type: 'pause' });
            return;
        }

        if (event.repeat) return;

        const column = this.keyToColumn.get(event.code);
        if (column === undefined) return;

        event.preventDefault();

        if (this.pressed[column]) return;
        this.pressed[column] = true;

        if (this.paused || this.finished || this.settings.auto) return;

        this.audio.keyDown(column);
        this.tap(column);
    }

    handleKeyUp(event) {
        const column = this.keyToColumn.get(event.code);
        if (column === undefined) return;

        event.preventDefault();

        if (!this.pressed[column]) return;
        this.pressed[column] = false;

        if (this.paused || this.finished) return;

        this.release(column);
    }

    tap(column) {
        const now = this.judgeTime();
        const missWindow = this.windows.miss;

        let target = null;

        for (const note of this.notes) {
            if (note.column !== column) continue;
            if (note.headJudged) continue;

            const delta = note.startTime - now;
            if (delta > missWindow) break;
            if (delta >= -missWindow) {
                target = note;
                break;
            }
        }

        if (!target) return;

        const error = now - target.startTime;
        this.registerHead(target, this.resultFor(Math.abs(error)), error);
    }

    release(column) {
        const note = this.holdByColumn[column];
        if (!note || note.tailJudged) return;

        const now = this.judgeTime();
        const early = note.endTime - now;

        if (early <= 0) {
            this.registerTail(note, 'perfect', 0);
            return;
        }

        if (early <= this.windows.miss) {
            this.registerTail(note, this.resultFor(early * 1.5), early);
            return;
        }

        this.registerTail(note, 'miss', early);
    }

    pause() {
        if (!this.running || this.paused || this.finished) return;

        this.paused = true;
        this.audio.suspend();
        this.emit({ type: 'paused' });
    }

    resume() {
        if (!this.running || !this.paused) return;

        this.audio.resume();
        this.paused = false;
        this.emit({ type: 'resumed' });
    }

    fail() {
        if (this.finished || this.settings.auto) return;

        this.failed = true;
        this.finished = true;
        this.running = false;
        cancelAnimationFrame(this.raf);
        this.audio.stopMusic();
        this.detach();

        this.emit({ type: 'fail', summary: this.summary() });
    }

    finish() {
        if (this.finished) return;

        this.finished = true;
        this.running = false;
        cancelAnimationFrame(this.raf);
        this.audio.stopMusic();
        this.detach();

        this.emit({ type: 'finish', summary: this.summary() });
    }

    summary() {
        return {
            score: this.score,
            accuracy: this.accuracy,
            counts: { ...this.counts },
            maxCombo: this.maxCombo,
            totalObjects: this.notes.length,
            totalJudgements: this.totalJudgements,
            grade: gradeFor(this.accuracy),
            mods: [...(this.mods.acronyms ?? [])],
            rate: this.rate,
            scoreMultiplier: this.mods.scoreMultiplier ?? 1,
            failed: this.failed,
        };
    }

    detach() {
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);
        window.removeEventListener('resize', this._onResize);
        window.removeEventListener('blur', this._onBlur);
    }

    destroy() {
        this.running = false;
        this.finished = true;
        cancelAnimationFrame(this.raf);
        this.audio.stopMusic();
        this.detach();

        if (this.background?.src?.startsWith('blob:'))
            URL.revokeObjectURL(this.background.src);
    }

    // ---------------------------------------------------------------- rendering

    layout() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = this.canvas.clientWidth || window.innerWidth;
        const height = this.canvas.clientHeight || window.innerHeight;

        const pixelWidth = Math.max(1, Math.round(width * dpr));
        const pixelHeight = Math.max(1, Math.round(height * dpr));

        if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
        if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;

        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        this.width = width;
        this.height = height;

        const keyCount = this.beatmap.keyCount;
        const config = this.skinConfig;

        // Skin column widths/spacing are laid out proportionally, so skins keep
        // their relative column sizes at any resolution.
        const widths = numericArray(config?.columnWidth, keyCount, 30, { positive: true });
        const spacings = numericArray(config?.columnSpacing, keyCount - 1, 0);
        const lineUnits = numericArray(config?.columnLineWidth, keyCount + 1, 2);

        const totalUnits = widths.reduce((sum, value) => sum + value, 0)
            + spacings.reduce((sum, value) => sum + value, 0);
        const fieldWidth = Math.min(width * (keyCount > 6 ? 0.9 : 0.72), keyCount * 96);
        const unit = fieldWidth / Math.max(0.0001, totalUnits);

        const columns = [];
        let cursor = (width - fieldWidth) / 2;

        for (let index = 0; index < keyCount; index++) {
            const columnWidth = widths[index] * unit;
            columns.push({ x: cursor, width: columnWidth });
            cursor += columnWidth + (spacings[index] ?? 0) * unit;
        }

        const hitPosition = clamp(config?.hitPosition ?? DEFAULT_HIT_POSITION, 240, 480);
        const receptorY = clamp((hitPosition / 480) * height, height * 0.55, height * 0.95);

        this.columns = columns;
        this.colours = columns.map((_, index) => config?.colours?.[index] ?? defaultColumnColour(index, keyCount));
        this.lightColours = columns.map((_, index) => config?.lightColours?.[index] ?? this.colours[index]);

        const noteImages = this.skin?.images?.note ?? [];
        const heightScale = config?.widthForNoteHeightScale ?? 0;

        this.noteHeights = columns.map((column, index) => {
            const image = noteImages[index];
            let ratio;

            if (this.defaultLook) ratio = 1;
            else if (heightScale > 0) ratio = heightScale / widths[index];
            else if (image?.width) ratio = image.height / image.width;
            else ratio = 0.34;

            return clamp(ratio, 0.18, 0.9) * column.width;
        });

        this.lineWidths = lineUnits.map(units => clamp(units * unit, 0, 12));

        this.field = {
            x: (width - fieldWidth) / 2,
            width: fieldWidth,
            columns,
            noteHeights: this.noteHeights,
            receptorY,
            topY: height * 0.04,
            scrollLength: receptorY - height * 0.04,
        };

        this.timeRange = 11485 / clamp(this.settings.scrollSpeed, 1, 40);
        this.pxPerMs = this.field.scrollLength / this.timeRange;
    }

    render(now) {
        const { ctx } = this;
        const { x, width: fieldWidth, topY, receptorY } = this.field;

        ctx.clearRect(0, 0, this.width, this.height);
        this.drawBackground();

        if (this.defaultLook) {
            // Classic default skin: plain black field, no lane decoration.
            ctx.fillStyle = '#000000';
            ctx.fillRect(x, topY, fieldWidth, receptorY - topY + 20);
        } else {
            ctx.fillStyle = 'rgba(6, 8, 14, 0.5)';
            ctx.fillRect(x, topY, fieldWidth, receptorY - topY + 20);

            for (let column = 0; column < this.columns.length; column++) {
                const geometry = this.columns[column];
                const colour = this.colours[column];

                ctx.fillStyle = this.pressed[column]
                    ? 'rgba(255, 255, 255, 0.085)'
                    : hexToRgba(colour, column % 2 === 0 ? 0.09 : 0.04);
                ctx.fillRect(geometry.x, topY, geometry.width, receptorY - topY + 20);

                if (this.pressed[column]) {
                    const glow = ctx.createLinearGradient(0, receptorY - 150, 0, receptorY);
                    glow.addColorStop(0, 'rgba(255, 255, 255, 0)');
                    glow.addColorStop(1, hexToRgba(this.lightColours[column], 0.3));
                    ctx.fillStyle = glow;
                    ctx.fillRect(geometry.x, receptorY - 150, geometry.width, 150);
                }
            }

            // Column lines, using the skin's ColumnLineWidth when provided.
            for (let index = 0; index <= this.columns.length; index++) {
                const last = this.columns[this.columns.length - 1];
                const lineX = index < this.columns.length
                    ? this.columns[index].x
                    : last.x + last.width;
                const lineWidth = Math.max(1, this.lineWidths[index] ?? 1);

                ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
                ctx.fillRect(lineX - lineWidth / 2, topY, lineWidth, receptorY - topY + 20);
            }

            if (this.skinConfig?.showJudgementLine !== false) {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
                ctx.fillRect(x, receptorY, fieldWidth, 1);
            }
        }

        ctx.save();
        ctx.beginPath();
        ctx.rect(x, topY, fieldWidth, receptorY - topY + 2);
        ctx.clip();
        this.drawNotes(now);
        ctx.restore();

        this.drawReceptors();
        this.drawFlashes();
        this.drawKeyLabels();
        this.drawCombo();
    }

    drawBackground() {
        const { ctx, width, height } = this;
        const hasBackground = this.background?.complete && this.background.naturalWidth;

        if (this.defaultLook && !hasBackground) {
            // Default skin: solid black playfield, as in osu!mania.
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, width, height);
            return;
        }

        if (hasBackground) {
            const scale = Math.max(width / this.background.naturalWidth, height / this.background.naturalHeight);
            const drawWidth = this.background.naturalWidth * scale;
            const drawHeight = this.background.naturalHeight * scale;

            ctx.drawImage(this.background, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
            ctx.fillStyle = `rgba(4, 5, 10, ${clamp(this.settings.backgroundDim, 0, 100) / 100})`;
            ctx.fillRect(0, 0, width, height);
            return;
        }

        const base = ctx.createLinearGradient(0, 0, 0, height);
        base.addColorStop(0, '#0a0c14');
        base.addColorStop(0.55, '#10131f');
        base.addColorStop(1, '#191c2a');
        ctx.fillStyle = base;
        ctx.fillRect(0, 0, width, height);

        const glow = ctx.createRadialGradient(
            width / 2, height * 0.45, 0,
            width / 2, height * 0.45, Math.max(width, height) * 0.7,
        );
        glow.addColorStop(0, 'rgba(88, 120, 255, 0.18)');
        glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, width, height);

        ctx.fillStyle = `rgba(4, 5, 10, ${clamp(this.settings.backgroundDim, 0, 100) / 250})`;
        ctx.fillRect(0, 0, width, height);
    }

    hiddenCoverage() {
        // ManiaModHidden: 160px at 0 combo, growing 0.5px per combo up to 400px,
        // relative to the 768px reference playfield.
        const coverage = Math.min(400, 160 + this.combo * 0.5);
        return coverage * ((this.field.receptorY - this.field.topY) / 768);
    }

    drawNotes(now) {
        const { ctx } = this;
        const { receptorY, topY, noteHeights } = this.field;
        const distanceNow = this.beatmap.distanceAt(now);
        const images = this.skin?.images;
        const hideLine = this.hidden ? receptorY - this.hiddenCoverage() : null;

        for (const note of this.notes) {
            if (note.headJudged && !note.isHold) continue;
            if (note.isHold && note.headJudged && note.tailJudged) continue;
            if (note.startTime - now > this.timeRange * 4) continue;

            const headY = receptorY - (this.beatmap.distanceAt(note.startTime) - distanceNow) * this.pxPerMs;
            const tailY = note.isHold
                ? receptorY - (this.beatmap.distanceAt(note.endTime) - distanceNow) * this.pxPerMs
                : headY;

            // Head is the lower end of a hold (it is the earlier time).
            if (Math.min(headY, tailY) > receptorY + noteHeights[note.column]) continue;
            if (Math.max(headY, tailY) < topY - noteHeights[note.column]) continue;

            let alpha = 1;

            // Hidden fades incoming notes out; an active hold stays visible.
            if (hideLine !== null && !note.headJudged) {
                alpha = clamp((hideLine - headY) / 50, 0, 1);
                if (alpha <= 0.01) continue;
            }

            const geometry = this.columns[note.column];

            if (this.defaultLook) {
                this.drawDefaultNote(note, geometry, headY, tailY, alpha);
                continue;
            }

            const colour = this.colours[note.column];
            const noteHeight = noteHeights[note.column];
            const noteImage = images?.note?.[note.column];
            const headImage = note.isHold
                ? images?.noteH?.[note.column] ?? noteImage
                : noteImage;
            const padding = noteImage ? 0 : Math.max(3, geometry.width * 0.07);
            const noteX = geometry.x + padding;
            const noteWidth = geometry.width - padding * 2;

            ctx.save();
            ctx.globalAlpha = alpha;

            if (note.isHold) {
                const bodyTop = Math.max(tailY, topY);
                const bodyBottom = Math.min(headY, receptorY);
                const bodyImage = images?.noteL?.[note.column];

                if (bodyBottom > bodyTop) {
                    if (bodyImage) {
                        ctx.drawImage(bodyImage, noteX, bodyTop, noteWidth, bodyBottom - bodyTop);
                    } else {
                        ctx.fillStyle = hexToRgba(colour, 0.34);
                        ctx.fillRect(noteX, bodyTop, noteWidth, bodyBottom - bodyTop);
                        ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
                        ctx.fillRect(noteX + noteWidth / 2 - 1.5, bodyTop, 3, bodyBottom - bodyTop);
                    }
                }

                const tailImage = images?.noteT?.[note.column];

                if (!note.tailJudged && tailY >= topY && tailY <= receptorY + noteHeight) {
                    if (tailImage) {
                        ctx.drawImage(
                            tailImage,
                            noteX,
                            tailY - noteHeight * 0.35,
                            noteWidth,
                            noteHeight * 0.7,
                        );
                    } else {
                        roundedRect(ctx, noteX, tailY - noteHeight * 0.3, noteWidth, noteHeight * 0.6, 3);
                        ctx.fillStyle = hexToRgba(colour, 0.8);
                        ctx.fill();
                    }
                }

                if (note.headJudged) {
                    ctx.restore();
                    continue;
                }
            }

            const headTop = headY - noteHeight / 2;

            if (headImage) {
                ctx.drawImage(headImage, noteX, headTop, noteWidth, noteHeight);
            } else {
                ctx.save();
                ctx.shadowColor = hexToRgba(colour, 0.55);
                ctx.shadowBlur = 14;

                roundedRect(ctx, noteX, headTop, noteWidth, noteHeight, Math.min(5, noteHeight / 3));
                ctx.fillStyle = colour;
                ctx.fill();
                ctx.restore();

                ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
                ctx.fillRect(noteX + 2, headTop + 2, noteWidth - 4, Math.max(1, noteHeight * 0.16));
                ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
                ctx.fillRect(noteX + 2, headY + noteHeight / 2 - 3, noteWidth - 4, 2);
            }

            ctx.restore();
        }
    }

    drawReceptors() {
        if (this.defaultLook) {
            this.drawDefaultReceptors();
            return;
        }

        const { ctx } = this;
        const { receptorY } = this.field;
        const images = this.skin?.images;

        for (let column = 0; column < this.columns.length; column++) {
            const geometry = this.columns[column];
            const colour = this.lightColours[column];
            const pressed = this.pressed[column];

            const keyImage = pressed
                ? images?.keyD?.[column] ?? images?.key?.[column]
                : images?.key?.[column];

            if (keyImage) {
                const keyHeight = (keyImage.height / keyImage.width) * geometry.width;
                ctx.drawImage(
                    keyImage,
                    geometry.x,
                    receptorY - keyHeight * 0.25,
                    geometry.width,
                    keyHeight,
                );
                continue;
            }

            const inset = Math.max(3, geometry.width * 0.06);

            ctx.save();
            ctx.shadowColor = pressed ? hexToRgba(colour, 0.9) : 'rgba(0, 0, 0, 0)';
            ctx.shadowBlur = pressed ? 18 : 0;

            roundedRect(ctx, geometry.x + inset, receptorY - 7, geometry.width - inset * 2, 8, 4);
            ctx.fillStyle = pressed ? colour : 'rgba(255, 255, 255, 0.16)';
            ctx.fill();
            ctx.restore();

            ctx.fillStyle = pressed ? 'rgba(255, 255, 255, 0.9)' : 'rgba(255, 255, 255, 0.25)';
            ctx.fillRect(geometry.x + inset, receptorY - 7, geometry.width - inset * 2, 1);
        }
    }

    drawDefaultCircle(x, y, radius) {
        const { ctx } = this;

        ctx.beginPath();
        ctx.arc(x, y, Math.max(1, radius), 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = Math.max(1, radius * 0.07);
        ctx.strokeStyle = '#0a0a0a';
        ctx.stroke();
    }

    drawDefaultNote(note, geometry, headY, tailY, alpha) {
        const { ctx } = this;
        const { topY, receptorY } = this.field;
        const centreX = geometry.x + geometry.width / 2;
        const radius = geometry.width * 0.44;

        ctx.save();
        ctx.globalAlpha = alpha;

        if (note.isHold) {
            const bodyTop = Math.max(tailY, topY);
            const bodyBottom = Math.min(headY, receptorY);
            const bodyWidth = Math.max(3, radius * 0.45);

            if (bodyBottom > bodyTop) {
                roundedRect(ctx, centreX - bodyWidth / 2, bodyTop, bodyWidth, bodyBottom - bodyTop, bodyWidth / 2);
                ctx.fillStyle = '#ffffff';
                ctx.strokeStyle = '#0a0a0a';
                ctx.lineWidth = Math.max(1, bodyWidth * 0.16);
                ctx.fill();
                ctx.stroke();
            }

            if (!note.tailJudged && tailY >= topY && tailY <= receptorY + radius)
                this.drawDefaultCircle(centreX, tailY, radius * 0.62);
        }

        if (!note.isHold || !note.headJudged)
            this.drawDefaultCircle(centreX, headY, radius);

        ctx.restore();
    }

    drawDefaultReceptors() {
        const { ctx } = this;
        const { receptorY } = this.field;

        for (let column = 0; column < this.columns.length; column++) {
            const geometry = this.columns[column];
            const centreX = geometry.x + geometry.width / 2;
            const radius = geometry.width * 0.44;
            const pressed = this.pressed[column];

            ctx.save();
            ctx.shadowColor = pressed ? 'rgba(255, 255, 255, 0.55)' : 'rgba(0, 0, 0, 0)';
            ctx.shadowBlur = pressed ? 16 : 0;
            ctx.beginPath();
            ctx.arc(centreX, receptorY, radius, 0, Math.PI * 2);
            ctx.fillStyle = pressed ? '#9a9a9a' : '#000000';
            ctx.fill();
            ctx.lineWidth = Math.max(1.5, radius * 0.07);
            ctx.strokeStyle = pressed ? '#f4f4f4' : '#ffffff';
            ctx.stroke();
            ctx.restore();
        }
    }

    drawCombo() {
        if (this.combo <= 0) return;

        const { ctx } = this;
        const { x, width: fieldWidth, receptorY, scrollLength } = this.field;
        const size = clamp((this.columns[0]?.width ?? 64) * 0.45, 18, 80);
        const elapsed = performance.now() - (this.comboChangedAt ?? 0);
        const pop = elapsed < 150 ? 1 + 0.2 * (1 - elapsed / 150) : 1;

        ctx.save();
        ctx.translate(x + fieldWidth / 2, receptorY - scrollLength * 0.6);
        ctx.scale(pop, pop);
        ctx.font = `800 ${size}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = Math.max(2, size * 0.12);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.fillStyle = '#ffffff';
        ctx.strokeText(String(this.combo), 0, 0);
        ctx.fillText(String(this.combo), 0, 0);
        ctx.restore();
    }

    drawFlashes() {
        const { ctx } = this;
        const { receptorY } = this.field;
        const now = performance.now();

        this.flashes = this.flashes.filter(flash => now - flash.at < 260);

        for (const flash of this.flashes) {
            const age = (now - flash.at) / 260;
            const geometry = this.columns[flash.column];
            if (!geometry) continue;

            const centreX = geometry.x + geometry.width / 2;
            const hitImage = this.skin?.images?.hit?.[JUDGEMENTS[flash.result].value];

            if (hitImage) {
                const drawWidth = geometry.width * 1.2 * (1 + age * 0.18);
                const drawHeight = drawWidth * hitImage.height / hitImage.width;

                ctx.save();
                ctx.globalAlpha = (1 - age) * 0.9;
                ctx.drawImage(hitImage, centreX - drawWidth / 2, receptorY - drawHeight / 2, drawWidth, drawHeight);
                ctx.restore();
                continue;
            }

            const alpha = (1 - age) * 0.5;
            const radius = geometry.width * 0.9;

            const gradient = ctx.createRadialGradient(centreX, receptorY, 0, centreX, receptorY, radius);
            gradient.addColorStop(0, hexToRgba(flash.colour, alpha));
            gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = gradient;
            ctx.fillRect(centreX - radius, receptorY - radius, radius * 2, radius * 2);
        }
    }

    drawKeyLabels() {
        // The classic default skin has no key labels under the receptors.
        if (this.defaultLook) return;

        const { ctx } = this;
        const { receptorY } = this.field;

        ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (let column = 0; column < this.keyCodes.length; column++) {
            const geometry = this.columns[column];
            if (!geometry) continue;

            ctx.fillStyle = this.pressed[column] ? 'rgba(255, 255, 255, 0.85)' : 'rgba(255, 255, 255, 0.3)';
            ctx.fillText(keyLabel(this.keyCodes[column]), geometry.x + geometry.width / 2, receptorY + 26);
        }
    }
}
