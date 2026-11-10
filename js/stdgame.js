// osu!standard gameplay: hit circles, sliders and spinners.
//
// Judging follows OsuHitWindows (300/100/50 windows from OD, fixed 400ms miss
// window) and the osu! approach circle timing from AR. Sliders are scored as a
// head and a tail; slider ticks and spinner bonus spins are not simulated.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// IBeatmapDifficultyInfo.DifficultyRange: linear interpolation across the
// 0-5-10 difficulty range used by the health constants.
function difficultyRange(difficulty, min, mid, max) {
    if (difficulty > 5) return mid + (max - mid) * (difficulty - 5) / 5;
    if (difficulty < 5) return mid - (mid - min) * (5 - difficulty) / 5;
    return mid;
}

export const STD_JUDGEMENTS = {
    great: { label: '300', value: 300, colour: '#8fe8ff' },
    ok: { label: '100', value: 100, colour: '#8ef29a' },
    meh: { label: '50', value: 50, colour: '#ffe066' },
    miss: { label: 'MISS', value: 0, colour: '#ff5c72' },
};

export const STD_JUDGEMENT_ORDER = ['great', 'ok', 'meh', 'miss'];

const COMBO_COLOURS = ['#ff66aa', '#66ccff', '#8ef29a', '#ffe066'];

export function standardHitWindows(overallDifficulty) {
    const range = (min, mid, max) => {
        if (overallDifficulty > 5) return mid + (max - mid) * (overallDifficulty - 5) / 5;
        if (overallDifficulty < 5) return mid - (mid - min) * (5 - overallDifficulty) / 5;
        return mid;
    };

    return {
        great: Math.floor(range(80, 50, 20)) - 0.5,
        ok: Math.floor(range(140, 100, 60)) - 0.5,
        meh: Math.floor(range(200, 150, 100)) - 0.5,
        miss: 400,
    };
}

export function approachTime(approachRate) {
    if (approachRate > 5) return 1200 - (1200 - 450) * (approachRate - 5) / 5;
    if (approachRate < 5) return 1800 - (1800 - 1200) * (5 - approachRate) / 5;
    return 1200;
}

function standardGrade(accuracy) {
    if (accuracy >= 100) return 'SS';
    if (accuracy >= 95) return 'S';
    if (accuracy >= 90) return 'A';
    if (accuracy >= 80) return 'B';
    if (accuracy >= 70) return 'C';
    return 'D';
}

function pathPositionAt(path, progress) {
    const target = clamp(progress, 0, 1) * path.length;
    const { points, cumulative } = path;

    if (!points.length) return { x: 0, y: 0 };
    if (points.length === 1 || path.length <= 0) return points[0];

    let low = 0;
    let high = cumulative.length - 1;

    while (low < high - 1) {
        const mid = (low + high) >> 1;
        if (cumulative[mid] <= target) low = mid;
        else high = mid;
    }

    const span = cumulative[high] - cumulative[low];
    const ratio = span > 0 ? (target - cumulative[low]) / span : 0;

    return {
        x: points[low].x + (points[high].x - points[low].x) * ratio,
        y: points[low].y + (points[high].y - points[low].y) * ratio,
    };
}

function sliderPosition(slider, time) {
    const elapsed = clamp(time - slider.time, 0, slider.duration);
    const spanDuration = Math.max(1, slider.spanDuration);
    const spanIndex = Math.min(slider.slides - 1, Math.floor(elapsed / spanDuration));
    const local = (elapsed - spanIndex * spanDuration) / spanDuration;
    const progress = spanIndex % 2 === 0 ? local : 1 - local;

    return pathPositionAt(slider.path, progress);
}

export class OsuGame {
    constructor({ canvas, beatmap, audio, settings, mods, onEvent }) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.beatmap = beatmap;
        this.audio = audio;
        this.settings = settings;
        this.mods = mods ?? { ids: [], rate: 1, scoreMultiplier: 1 };
        this.onEvent = onEvent ?? (() => {});

        this.rate = this.mods.rate ?? 1;
        this.offsetSeconds = (Number(settings.offset) || 0) / 1000;
        this.windows = standardHitWindows(beatmap.overallDifficulty);

        // OsuHealthProcessor drain rate is derived from the map's HP setting.
        // The legacy solver targets ~90% minimum health on a perfect play at
        // HP5; this constant reproduces roughly that passive pressure.
        this.drainRate = clamp(Number(beatmap.drainRate) || 0, 0, 10);
        this.drainPerMs = this.drainRate * 0.004 / 1000;
        this.health = 1;
        this.healthAt = null;

        // EZ/HR widen or tighten the 300/100/50 windows (the miss window is fixed).
        const windowDivisor = this.mods.windowMultiplier ?? 1;
        for (const key of ['great', 'ok', 'meh']) this.windows[key] /= windowDivisor;
        this.preempt = approachTime(beatmap.approachRate);
        this.fadeIn = 400 * Math.min(1, this.preempt / 450);
        this.radius = 32 * (1 - 0.7 * ((beatmap.circleSize - 5) / 5));

        this.hits = beatmap.hits.map((hit, index) => ({
            ...hit,
            index,
            colour: COMBO_COLOURS[index % COMBO_COLOURS.length],
            headJudged: false,
            tailJudged: false,
            headResult: null,
            tailResult: null,
            holding: false,
        }));

        this.totalJudgements = Math.max(1, beatmap.maxJudgements);
        this.maxComboSum = this.totalJudgements * (this.totalJudgements + 1) / 2;

        this.counts = { great: 0, ok: 0, meh: 0, miss: 0 };
        this.score = 0;
        this.combo = 0;
        this.maxCombo = 0;
        this.accuracy = 100;
        this.hitSum = 0;
        this.progressSum = 0;
        this.judged = 0;

        this.cursor = { x: 256, y: 192 };
        this.down = false;
        this.bursts = [];
        this.background = null;

        this.running = false;
        this.paused = false;
        this.finished = false;
        this.failed = false;
        this.startCtxTime = 0;
        this.startSongTime = 0;
        this.lastHudAt = 0;

        this._onPointerMove = event => this.trackPointer(event);
        this._onPointerDown = event => {
            this.trackPointer(event);
            this.press();
        };
        this._onPointerUp = () => this.release();
        this._onKeyDown = event => {
            if (event.code === 'Escape') {
                this.emit({ type: 'pause' });
                return;
            }

            if (event.code !== 'KeyZ' && event.code !== 'KeyX' && event.code !== 'Space') return;
            event.preventDefault();
            if (!event.repeat) this.press();
        };
        this._onKeyUp = event => {
            if (event.code !== 'KeyZ' && event.code !== 'KeyX' && event.code !== 'Space') return;
            this.release();
        };
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

        this.scale = Math.min(width / 512, height / 384) * 0.94;
        this.origin = {
            x: (width - 512 * this.scale) / 2,
            y: (height - 384 * this.scale) / 2,
        };
    }

    start() {
        this.audio.ensure();
        this.audio.setVolume(this.settings.volume);

        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
        window.addEventListener('resize', this._onResize);
        window.addEventListener('blur', this._onBlur);
        this.canvas.addEventListener('pointermove', this._onPointerMove);
        this.canvas.addEventListener('pointerdown', this._onPointerDown);
        this.canvas.addEventListener('pointerup', this._onPointerUp);

        const leadIn = 2200;
        this.startSongTime = Math.max(0, this.beatmap.firstTime - leadIn);
        this.startCtxTime = this.audio.now() + 0.3;

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

    songTime() {
        return this.startSongTime + (this.audio.now() - this.startCtxTime) * 1000 * this.rate;
    }

    // Universal offset: positive values shift judging later in real time.
    judgeTime() {
        return this.songTime() - this.offsetSeconds * 1000;
    }

    progress() {
        const span = Math.max(1, this.beatmap.lastTime - this.beatmap.firstTime);
        return clamp((this.songTime() - this.beatmap.firstTime) / span, 0, 1);
    }

    // Passive health drain, limited to the playable span of the map. Elapsed
    // time is clamped so a suspended tab cannot empty the bar in one frame.
    drainHealth() {
        if (this.settings.auto || this.finished) return;

        const now = this.songTime();
        if (this.healthAt === null) this.healthAt = now;

        const elapsed = clamp(now - this.healthAt, 0, 120);
        this.healthAt = now;

        if (elapsed <= 0 || now < this.beatmap.firstTime || now > this.beatmap.lastTime) return;

        this.health = clamp(this.health - this.drainPerMs * elapsed, 0, 1);
        if (this.health <= 0) this.fail();
    }

    // OsuHealthProcessor values: hits restore a little health, misses take a
    // chunk depending on HP, and slider tails are worth less than circle heads.
    healthIncrease(result, tail) {
        const range = (min, mid, max) => difficultyRange(this.drainRate, min, mid, max);

        switch (result) {
            case 'great': return tail ? 0.02 : 0.03;
            case 'ok': return 0.011;
            case 'meh': return 0.002;
            default: return tail ? range(-0.02, -0.075, -0.14) : range(-0.03, -0.125, -0.2);
        }
    }

    applyHealth(result, tail) {
        if (this.settings.auto) return false;

        this.health = clamp(this.health + this.healthIncrease(result, tail), 0, 1);
        return this.health <= 0;
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

    frame() {
        if (!this.running) return;

        const now = this.songTime();

        if (!this.paused) {
            this.drainHealth();
            if (this.finished) return;
            this.update(this.judgeTime());
            this.emitHud();
        }

        this.render(now);

        if (this.running) this.raf = requestAnimationFrame(this.frame);
    }

    // ------------------------------------------------------------------ input

    trackPointer(event) {
        if (!this.scale) return;

        const rect = this.canvas.getBoundingClientRect();
        this.cursor = {
            x: (event.clientX - rect.left - this.origin.x) / this.scale,
            y: (event.clientY - rect.top - this.origin.y) / this.scale,
        };
    }

    press() {
        if (this.paused || this.finished || this.settings.auto) return;

        this.audio.ensure();
        this.down = true;

        const now = this.judgeTime();
        this.audio.keyDown(0);

        const spinner = this.hits.find(hit => hit.type === 'spinner'
            && now >= hit.time - this.windows.meh
            && now <= hit.endTime
            && !hit.headJudged);

        if (spinner) {
            spinner.holding = true;
            return;
        }

        let best = null;
        let bestDelta = Infinity;

        for (const hit of this.hits) {
            if (hit.headJudged || hit.type === 'spinner') continue;

            const delta = Math.abs(hit.time - now);
            // Taps outside the 50 window are ignored, exactly like osu!, so an
            // early click does not consume a circle that is still approaching.
            if (delta > this.windows.meh) {
                if (hit.time > now) break;
                continue;
            }

            const distance = Math.hypot(this.cursor.x - hit.x, this.cursor.y - hit.y);
            if (distance > this.radius * 2) continue;

            if (delta < bestDelta) {
                best = hit;
                bestDelta = delta;
            }
        }

        if (best) this.registerHead(best, this.resultFor(bestDelta));
    }

    release() {
        this.down = false;

        if (this.paused || this.finished) return;

        const now = this.songTime();

        // Sliders keep their head judgement; the tail is checked when the slide ends.
        for (const hit of this.hits) {
            if (hit.type === 'slider' && hit.tailJudged) continue;
            if (hit.type === 'slider') hit.holding = false;
        }
    }

    resultFor(delta) {
        if (delta <= this.windows.great) return 'great';
        if (delta <= this.windows.ok) return 'ok';
        if (delta <= this.windows.meh) return 'meh';
        return 'miss';
    }

    // --------------------------------------------------------------- judging

    register(result, tail = false) {
        if (this.finished) return;

        const fatal = this.applyHealth(result, tail);

        this.counts[result]++;
        this.judged++;
        this.hitSum += STD_JUDGEMENTS[result].value;

        if (result === 'miss') {
            this.combo = 0;
        } else {
            this.combo++;
            this.maxCombo = Math.max(this.maxCombo, this.combo);
        }

        this.progressSum += this.combo;

        this.accuracy = this.judged ? this.hitSum / (300 * this.judged) * 100 : 100;

        const baseScore = 300000 * (this.hitSum / (300 * this.totalJudgements))
            + 700000 * (this.progressSum / this.maxComboSum);

        this.score = Math.round(baseScore * (this.mods.scoreMultiplier ?? 1));

        this.emitHud(true);
        if (fatal) this.fail();
    }

    emitJudgement(result) {
        this.emit({
            type: 'judgement',
            result,
            label: STD_JUDGEMENTS[result].label,
            colour: STD_JUDGEMENTS[result].colour,
            combo: this.combo,
        });
    }

    burst(x, y) {
        this.bursts.push({ x, y, at: performance.now() });
    }

    registerHead(hit, result) {
        if (hit.headJudged) return;

        hit.headJudged = true;
        hit.headResult = result;

        if (result === 'miss') {
            this.audio.miss();
        } else {
            this.audio.hitNote(0);
            this.burst(hit.x, hit.y);
        }

        this.register(result);
        this.emitJudgement(result);

        if (hit.type === 'slider') {
            if (result === 'miss') this.registerTail(hit, 'miss');
            else hit.holding = true;
        }
    }

    registerTail(hit, result) {
        if (hit.tailJudged) return;

        hit.tailJudged = true;
        hit.holding = false;
        hit.tailResult = result;

        if (result === 'miss') {
            this.audio.miss();
        } else {
            this.burst(hit.endX, hit.endY);
        }

        this.register(result, true);
        this.emitJudgement(result);
    }

    update(now) {
        for (const hit of this.hits) {
            if (this.finished) break;

            if (hit.type === 'circle') {
                if (!hit.headJudged && now > hit.time + this.windows.meh)
                    this.registerHead(hit, 'miss');
                continue;
            }

            if (hit.type === 'slider') {
                if (!hit.headJudged) {
                    if (now > hit.time + this.windows.meh) {
                        this.registerHead(hit, 'miss');
                        this.registerTail(hit, 'miss');
                    }
                    continue;
                }

                if (hit.tailJudged) continue;

                if (now >= hit.endTime) {
                    // The slide completes when the button is still down at the end.
                    const held = this.down || this.settings.auto;
                    this.registerTail(hit, held ? 'great' : 'miss');
                }
                continue;
            }

            if (hit.type === 'spinner' && !hit.headJudged) {
                if (now >= hit.time && now <= hit.endTime && this.down) hit.holding = true;
                if (now >= hit.endTime) {
                    const held = this.down || this.settings.auto;
                    this.registerHead(hit, held ? 'great' : 'miss');
                }
            }
        }

        if (this.settings.auto) this.updateAuto(now);

        if (!this.finished && now > this.beatmap.lastTime + 1800) this.finish();
    }

    updateAuto(now) {
        const target = this.hits.find(hit => (hit.type === 'spinner'
            ? now < hit.endTime + 60 && now > hit.time - this.preempt
            : !hit.headJudged && now < hit.time + 120));

        if (!target) {
            this.down = false;
            return;
        }

        if (target.type === 'circle') {
            this.moveCursor(target.x, target.y);
            this.down = now >= target.time - 30 && now <= target.time + 80;
            if (now >= target.time) this.registerHead(target, 'great');
            return;
        }

        if (target.type === 'slider') {
            if (now < target.time) {
                this.moveCursor(target.x, target.y);
                this.down = false;
                return;
            }

            const position = sliderPosition(target, now);
            this.moveCursor(position.x, position.y);
            this.down = now <= target.endTime + 20;

            if (!target.headJudged && now >= target.time) this.registerHead(target, 'great');
            return;
        }

        this.moveCursor(256, 192);
        this.down = now >= target.time && now <= target.endTime;
        if (this.down) target.holding = true;
    }

    moveCursor(x, y) {
        this.cursor.x += (x - this.cursor.x) * 0.35;
        this.cursor.y += (y - this.cursor.y) * 0.35;
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
        this.healthAt = null;
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
            mode: 'osu',
            score: this.score,
            accuracy: this.accuracy,
            counts: { ...this.counts },
            maxCombo: this.maxCombo,
            totalObjects: this.hits.length,
            totalJudgements: this.totalJudgements,
            grade: standardGrade(this.accuracy),
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
        this.canvas.removeEventListener('pointermove', this._onPointerMove);
        this.canvas.removeEventListener('pointerdown', this._onPointerDown);
        this.canvas.removeEventListener('pointerup', this._onPointerUp);
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

    // -------------------------------------------------------------- rendering

    render(now) {
        const { ctx } = this;

        ctx.clearRect(0, 0, this.width, this.height);
        this.drawBackground();

        ctx.save();
        ctx.translate(this.origin.x, this.origin.y);
        ctx.scale(this.scale, this.scale);

        for (const hit of this.hits) if (hit.type === 'slider') this.drawSlider(hit, now);
        for (const hit of this.hits) if (hit.type === 'circle') this.drawCircle(hit, now);
        for (const hit of this.hits) if (hit.type === 'spinner') this.drawSpinner(hit, now);

        this.drawBursts();
        this.drawCursor();

        ctx.restore();
        this.drawCombo();
    }

    drawBackground() {
        const { ctx, width, height } = this;
        const hasBackground = this.background?.complete && this.background.naturalWidth;

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
        base.addColorStop(0.6, '#10131f');
        base.addColorStop(1, '#191c2a');
        ctx.fillStyle = base;
        ctx.fillRect(0, 0, width, height);
    }

    visibleAlpha(hit, now) {
        const start = hit.time - this.preempt;
        return clamp((now - (start - this.fadeIn)) / this.fadeIn, 0, 1);
    }

    drawApproach(x, y, time, now, radius) {
        // Hidden removes approach circles in osu!standard.
        if (now > time || this.mods.hidden) return;

        const { ctx } = this;
        const progress = clamp((now - (time - this.preempt)) / this.preempt, 0, 1);
        const approachRadius = radius * (1 + 3 * (1 - progress));

        ctx.beginPath();
        ctx.arc(x, y, approachRadius, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.lineWidth = 3;
        ctx.stroke();
    }

    drawCircle(hit, now) {
        if (hit.headJudged) return;
        if (now < hit.time - this.preempt || now > hit.time + this.windows.meh) return;

        const { ctx } = this;
        const alpha = this.visibleAlpha(hit, now);
        const radius = this.radius;

        ctx.save();
        ctx.globalAlpha = alpha;

        this.drawApproach(hit.x, hit.y, hit.time, now, radius);

        ctx.beginPath();
        ctx.arc(hit.x, hit.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = hit.colour;
        ctx.fill();
        ctx.lineWidth = Math.max(2, radius * 0.11);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = `700 ${Math.round(radius * 0.95)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String((hit.index % 9) + 1), hit.x, hit.y + 1);

        ctx.restore();
    }

    drawSlider(hit, now) {
        if (now < hit.time - this.preempt || now > hit.endTime + 400) return;
        if (!hit.path?.points?.length) return;

        const { ctx } = this;
        const alpha = this.visibleAlpha(hit, now);
        const points = hit.path.points;

        ctx.save();
        ctx.globalAlpha = Math.min(1, alpha);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);

        ctx.strokeStyle = hit.colour;
        ctx.globalAlpha = alpha * 0.4;
        ctx.lineWidth = this.radius * 1.05;
        ctx.stroke();

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.globalAlpha = alpha * 0.5;
        ctx.lineWidth = this.radius * 0.9;
        ctx.stroke();

        ctx.strokeStyle = 'rgba(10, 12, 18, 0.45)';
        ctx.globalAlpha = alpha;
        ctx.lineWidth = this.radius * 0.62;
        ctx.stroke();

        ctx.globalAlpha = alpha;
        this.drawApproach(hit.x, hit.y, hit.time, now, this.radius);

        if (!hit.headJudged) {
            ctx.beginPath();
            ctx.arc(hit.x, hit.y, this.radius, 0, Math.PI * 2);
            ctx.fillStyle = hit.colour;
            ctx.fill();
            ctx.lineWidth = Math.max(2, this.radius * 0.11);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
            ctx.stroke();

            ctx.fillStyle = '#ffffff';
            ctx.font = `700 ${Math.round(this.radius * 0.95)}px ui-sans-serif, system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String((hit.index % 9) + 1), hit.x, hit.y + 1);
        }

        if (now >= hit.time && now <= hit.endTime + 40) {
            const position = sliderPosition(hit, now);
            const ballRadius = this.radius * 0.4;

            if (hit.holding) {
                ctx.beginPath();
                ctx.arc(position.x, position.y, this.radius * 1.5, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
                ctx.lineWidth = 3;
                ctx.stroke();
            }

            ctx.save();
            ctx.shadowColor = 'rgba(255, 255, 255, 0.8)';
            ctx.shadowBlur = 18;
            ctx.beginPath();
            ctx.arc(position.x, position.y, ballRadius, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.restore();
        }

        ctx.restore();
    }

    drawSpinner(hit, now) {
        if (now < hit.time - this.preempt || now > hit.endTime + 300) return;

        const { ctx } = this;
        const alpha = this.visibleAlpha(hit, now);
        const duration = Math.max(1, hit.endTime - hit.time);
        const progress = clamp((now - hit.time) / duration, 0, 1);
        const radius = 110;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(256, 192);

        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
        ctx.lineWidth = 8;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(0, 0, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 8;
        ctx.stroke();

        const spin = (now - hit.time) / 220;

        for (let i = 0; i < 4; i++) {
            const angle = spin + i * Math.PI / 2;
            ctx.beginPath();
            ctx.moveTo(Math.cos(angle) * radius * 0.35, Math.sin(angle) * radius * 0.35);
            ctx.lineTo(Math.cos(angle) * radius * 0.8, Math.sin(angle) * radius * 0.8);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
            ctx.lineWidth = 5;
            ctx.stroke();
        }

        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.font = '700 22px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('SPIN', 0, 0);

        ctx.restore();
    }

    drawBursts() {
        const { ctx } = this;
        const now = performance.now();

        this.bursts = this.bursts.filter(burst => now - burst.at < 240);

        for (const burst of this.bursts) {
            const progress = (now - burst.at) / 240;

            ctx.beginPath();
            ctx.arc(burst.x, burst.y, this.radius * (1 + progress * 0.9), 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(255, 255, 255, ${(1 - progress) * 0.7})`;
            ctx.lineWidth = 4 * (1 - progress) + 1;
            ctx.stroke();
        }
    }

    drawCursor() {
        const { ctx } = this;
        const { x, y } = this.cursor;

        ctx.beginPath();
        ctx.arc(x, y, 13, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(10, 14, 22, 0.25)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
    }

    drawCombo() {
        if (this.combo <= 0) return;

        const { ctx } = this;
        const size = clamp(this.height * 0.05, 26, 60);

        ctx.save();
        ctx.font = `800 ${Math.round(size)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = Math.max(3, size * 0.1);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillStyle = '#ffffff';
        ctx.strokeText(String(this.combo), 28, this.height * 0.45);
        ctx.fillText(String(this.combo), 28, this.height * 0.45);
        ctx.restore();
    }
}
