# osu!webfield

**osu!webfield** is a browser port of **osu!mania** and **osu!standard**, built alongside the osu! C# source.
Taiko and catch are not implemented. Everything is plain ES modules and canvas: no build
step, no dependencies, no server code.

This folder is self-contained: copy its **contents** into a new repository and GitHub
Pages can serve it as-is.

## What's in this folder

- `index.html`, `css/`, `js/` — the game
- `.github/workflows/pages.yml` — GitHub Pages deployment
- `.nojekyll` — keeps GitHub from running Jekyll over the files
- `LICENSE`, `README.md`

## Run it

ES modules need to be served over HTTP (opening `index.html` from disk is blocked by
module CORS rules). Any static server works:

```bash
python -m http.server 8080
# then open http://localhost:8080
```

Or with Node:

```bash
npx serve .
```

## Deploy on GitHub Pages

The included workflow (`.github/workflows/pages.yml`) publishes the repository root.
Create a repository and upload the **contents** of this folder (not the folder itself),
then set **Settings → Pages → Source** to **GitHub Actions**. Every push to
`main`/`master` deploys, and the workflow can also be run manually from the Actions tab.
All asset paths are relative, so the site works from `https://<user>.github.io/<repo>/`.

## Playing

- Drop an `.osz` (or a bare `.osu`) anywhere on the page, then press **Play**.
  Mania and standard difficulties are imported; taiko/catch are skipped and reported.
- Drop an `.osk` to load an osu! skin for mania, or use **Skins → Import .osk**.
- The library loads famous and beginner mapsets on first visit (roughly 1.6★–7.8★),
  cached by the browser after the first download.
- Autoplay is **off by default**; enable it in **Setup → Gameplay** to watch.

**osu!standard** uses the mouse (or touch) to aim and click, with `Z` / `X` / `Space` as
alternative tap keys. `Esc` pauses. Sliders are followed by holding until the end,
spinners by holding through their duration.

**osu!mania** uses osu!'s own layouts (`VariantMappingGenerator`): 4K `D F J K`, 7K
`S D F Space J K L`; edit them in **Setup → Keys**.

On a touch screen, tap the mania lanes directly. osu!standard follows your finger and
presses while you hold it, so sliders and spinners only need a finger kept down. The
pause button sits under the score, and the menu collapses to one column on phones.

## Featured maps

On the first visit the library loads a starter set from the osu! mirror:

- **DISCO PRINCE** — standard, 2.4★
- **Butterfly** — standard, 1.6–3.9★
- **Ievan Polkka** — standard, 1.6–4.9★
- **Ievan Polkka** — 4K/7K mania, 2.4–2.5★
- **Yomi yori Kikoyu…** — 4K mania, 4.99★
- **Blue Zenith / FREEDOM DiVE** — ranked 4K mania sets, 3.7–6.3★
- **The Big Black** — standard, 9 difficulties
- **Blue Zenith** — standard
- **FREEDOM DiVE** — 6K mania

Use the **All / osu!std / osu!mania** buttons above the library to filter charts.

Each `.osz` is downloaded once and stored in the browser's Cache Storage; later page
loads read them from that cache, so only the first visit needs the downloads. As with
any imported map, the charts and audio are rebuilt in memory for each session.

## Getting beatmaps online

**Get beatmaps** in the menu searches the osu! catalogue through
[osu.direct](https://osu.direct), a public osu! beatmap mirror. Type a song, artist or
mapper, choose Mania, Standard or both, and press **Download**. The `.osz` is fetched in
the browser and imported through the normal pipeline, so audio, background and every
difficulty come with it; the **osu!** button on a result opens the official mapset page.

osu.ppy.sh cannot be called directly from a static page: beatmap downloads require an
osu! login session, its search/API responses do not send CORS headers for browser
fetches, and the API needs OAuth. The mirror is third-party, may rate-limit or lag behind
the official listing, and can be unavailable. Downloaded maps stay in memory for the
session, like dropped files; featured downloads are also cached so they are not fetched
again.

## Accuracy

**osu!mania** accuracy uses the 300-based weights from osu!: MAX and 300 both count
as 100%, then 200/100/50 and a miss at 0%. The MAX judgement's 320 value only affects
score, so a full run of 300s reports 100.00%.

**osu!standard** uses the usual 300/100/50 weights. Slider ends are weighted as 150
(osu!lazer's `SliderTailHit`) rather than as a full 300, so imperfect slider heads are
not hidden by a perfect tail. Slider ticks and repeats are not simulated.

## Mods

Selected in **Setup → Mods** and persisted.

| Mod | Effect |
| --- | --- |
| EZ | Hit windows ×1.4, score ×0.5 |
| HR | Hit windows ÷1.4; standard also removes approach circle leniency of EZ |
| DT | Speeds the map up. **Speed is adjustable from 1.01× to 2.00×** (1.5× default) |
| HT | Slows the map down. **Speed is adjustable from 0.50× to 0.99×**; score multiplier follows `ManiaScoreMultiplierCalculator` (0.3× at 0.75×) |
| HD | Mania: notes fade before the hit line. Standard: approach circles are removed |
| MR | Mania: columns flipped horizontally |
| RD | Mania: columns shuffled per attempt |

Mutually exclusive pairs (EZ/HR, DT/HT, MR/RD) are enforced in the UI and when resolving
stored selections. Custom speeds persist in `localStorage` and are applied to the audio
playback rate, hit-window scaling, star rating and score.

## Click sounds

Every key tap or mouse click plays a synthesised osu!-style click (filtered noise burst)
through the Web Audio SFX bus. Toggle it with **Setup → Gameplay → Click sounds**.
Note hits still use the short synthesised hit blips, so the port is playable with no
skin samples at all.

## Offset calibration

**Setup → Gameplay → Universal offset** shifts hit judging by up to ±200 ms. Positive
values make hit windows land later, which compensates for delayed audio output or a habit
of tapping late; negative values do the opposite.

Press **Start metronome** for a 120 BPM click with a pulsing beat indicator, then tap
`Space` (or the **Tap** button) on each click. After four taps the panel shows the average
tap error and the jitter; **Apply** sets the offset from that average. The offset persists
in `localStorage` and applies to the next hit, including a map that is already running.

## Health and failing

Both modes start at 100% health and show the health bar under the song info.

- **osu!standard** drains health continuously while the map plays (not during the
  lead-in or after the last object), restores a little on hits (+0.03 for a 300,
  +0.011 for a 100, +0.002 for a 50), and takes 3–20% per miss depending on the map's HP
  setting. Slider tails restore +0.02 and a missed tail costs less than a missed circle.
- **osu!mania** has no passive drain. Health follows `ManiaHealthProcessor`: MAX restores
  a little (scaled by HP), 300/200 restore less, 100 is neutral, 50 and misses cost
  health, and a missed hold costs for both its head and tail.

If the bar reaches zero the run fails: the song stops and the results screen shows an
**F** with a failed banner. Autoplay cannot fail.

## Star ratings (mania)

Mania charts are rated with a port of `ManiaDifficultyCalculator` (version 20241007):
per-column and overall strain, 400 ms section peaks, hold overlap bonuses, `0.9` peak
weighting and the `0.018` scale. The port reproduces the repository test chart exactly:
**2.349376975** at 1.0× and **2.797245913** with 1.5× DT. Ratings follow the selected
rate mods and are shown in the library, dropdowns, HUD and results.

osu!standard star ratings are **not ported yet**; standard rows show an `osu!std` chip
instead of a rating.

## Difficulties and the library

Charts sharing artist, title and creator are grouped into one beatmapset. Sets with more
than one difficulty get a dropdown listing each difficulty's version, mode, key count and
mania star rating; **Play** plays the selected difficulty. Sets are separated by mode, so
a mapset with both mania and standard difficulties shows one row per ruleset.

## Skins (mania)

`skin.ini` is parsed like `LegacyManiaSkinDecoder` (multiple `[Mania]` sections, one per
`Keys` count): `ColumnWidth`, `ColumnSpacing`, `ColumnLineWidth`, `HitPosition`,
`Colour1..N`, `ColourLight1..N`, `WidthForNoteHeightScale`, `NoteBodyStyle` and the
`NoteImage*` / `KeyImage*` / `Hit*` lookups, with `mania-note{N}` (+`H`/`T`/`L`),
`mania-key{N}` (+`D`) and `mania-hit300g/300/200/100/50/0` sprites, preferring `@2x`.
Skins last for the session.

The built-in **Default** skin follows osu!mania's classic look: black playfield, white
circular notes, circle receptors that fill grey while held, capsule holds and a large
combo number drawn in the playfield. Standard uses procedural circles, sliders and
spinners with a white cursor.

## What is ported

| osu! (C#) | Web port |
| --- | --- |
| `ManiaRuleset` | `js/game.js` |
| `ManiaHitWindows` | same OD ranges, rate/difficulty multipliers, `floor(window) + 0.5` |
| `DrawableManiaRuleset.ComputeScrollTime` | `11485 / scrollSpeed` |
| `ManiaBeatmapConverter` | `floor(x * keyCount / 512)` |
| Mania SV / timing | integrated inherited points |
| `ManiaDifficultyCalculator` | `js/difficulty.js` (star rating) |
| `OsuRuleset` hit objects | `js/stdgame.js` + `js/beatmap.js` `parseOsuStandard` |
| `OsuHitWindows` | 300/100/50 windows from OD, 400 ms miss window |
| `OsuHitObject` preempt / radius | AR → 1800/1200/450 ms, CS → 64 px × scale |
| Slider velocity / duration | `100 × SliderMultiplier × SV / beatLength`, file pixel length, repeats |
| Slider paths | linear, bezier (red-anchor splits), catmull, perfect circle, trimmed to length |
| ScoreV2 split | 70% combo progress + 30% accuracy, then mod multipliers |
| `ManiaHealthProcessor` | judgement-only health with fail at zero |
| `OsuHealthProcessor` | passive drain, hit/miss health and fail at zero |
| `.osz` packages | zip reader over `DecompressionStream` |
| Mania skins | `js/skin.js` |

Not ported: taiko, catch, storyboards, editor, multiplayer, osu!direct, replays,
slider ticks and spinner bonus, animated skin frames, standard star rating.

## Limits

- Mania: 1–10 keys, single stage. Standard: circles, sliders and spinners.
- Standard sliders are scored as head + tail; slider ticks and repeat judgements are not
  simulated. Spinners only check that the button is held to the end (no spin bonus).
- Standard hit detection uses the object radius (with leniency for slider heads) and
  ignores stacking.
- No No Fail or other fail-condition mods; health and failing match the base rulesets.
- Audio depends on the browser's `decodeAudioData`; unsupported files play silently with
  synthesised hitsounds.
- Skins are not persisted between page loads; mods, keybinds, rates and settings are.
