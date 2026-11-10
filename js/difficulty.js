// Star rating port of osu.Game.Rulesets.Mania.Difficulty (calculator version 20241007).
//
// Ported from:
//   ManiaDifficultyCalculator.CreateDifficultyAttributes / CreateDifficultyHitObjects
//   ManiaDifficultyHitObject
//   Skills/Strain (individual + overall strain, section peaks)
//   Evaluators/IndividualStrainEvaluator, Evaluators/OverallStrainEvaluator
//
// The only mods that change mania star rating are rate-changing ones (DT/HT); EZ/HR
// adjust hit windows, which the strain algorithm never reads.

const DIFFICULTY_MULTIPLIER = 0.018;
const SECTION_LENGTH = 400;
const DECAY_WEIGHT = 0.9;
const INDIVIDUAL_DECAY_BASE = 0.125;
const OVERALL_DECAY_BASE = 0.3;
const RELEASE_THRESHOLD = 30;

const decay = (value, deltaTime, base) => value * Math.pow(base, deltaTime / 1000);

const logistic = (x, midpointOffset, multiplier, maxValue = 1) =>
    maxValue / (1 + Math.exp(multiplier * (midpointOffset - x)));

// osu.Framework.Utils.Precision.DefinitelyBigger.
const definitelyBigger = (a, b, tolerance) => a - b > tolerance;

function buildDifficultyObjects(hits, totalColumns, clockRate) {
    // LegacySortHelper sorts by rounded start time before objects are wrapped.
    const sorted = [...hits].sort((a, b) => Math.round(a.time) - Math.round(b.time));
    const objects = [];
    const perColumn = Array.from({ length: totalColumns }, () => []);

    // The first hit object generates no strain, matching the C# loop starting at 1.
    for (let i = 1; i < sorted.length; i++) {
        const hit = sorted[i];
        const last = sorted[i - 1];
        const column = Math.min(totalColumns - 1, Math.max(0, hit.column));

        const previousInColumn = perColumn[column].length
            ? perColumn[column][perColumn[column].length - 1]
            : null;

        const previousObjects = new Array(totalColumns).fill(null);
        if (objects.length) {
            const previous = objects[objects.length - 1];
            for (let index = 0; index < totalColumns; index++)
                previousObjects[index] = previous.previousObjects[index];
            previousObjects[previous.column] = previous;
        }

        const startTime = hit.time / clockRate;
        const endTime = (hit.endTime ?? hit.time) / clockRate;

        const object = {
            index: objects.length,
            column,
            startTime,
            endTime,
            deltaTime: (hit.time - last.time) / clockRate,
            columnStrainTime: previousInColumn ? startTime - previousInColumn.startTime : startTime,
            previousInColumn,
            previousObjects,
        };

        objects.push(object);
        perColumn[column].push(object);
    }

    return objects;
}

function individualStrainValue(current) {
    let holdFactor = 1;

    // Bonus when this note starts and ends inside another note's hold.
    for (const previous of current.previousObjects) {
        if (!previous) continue;

        if (definitelyBigger(previous.endTime, current.endTime, 1)
            && definitelyBigger(current.startTime, previous.startTime, 1)) {
            holdFactor = 1.25;
            break;
        }
    }

    return 2 * holdFactor;
}

function overallStrainValue(current) {
    let isOverlapping = false;
    let closestEndTime = Math.abs(current.endTime - current.startTime);
    let holdFactor = 1;
    let holdAddition = 0;

    for (const previous of current.previousObjects) {
        if (!previous) continue;

        isOverlapping = isOverlapping
            || (definitelyBigger(previous.endTime, current.startTime, 1)
                && definitelyBigger(current.endTime, previous.endTime, 1)
                && definitelyBigger(current.startTime, previous.startTime, 1));

        if (definitelyBigger(previous.endTime, current.endTime, 1)
            && definitelyBigger(current.startTime, previous.startTime, 1)) {
            holdFactor = 1.25;
        }

        closestEndTime = Math.min(closestEndTime, Math.abs(current.endTime - previous.endTime));
    }

    if (isOverlapping)
        holdAddition = logistic(closestEndTime, RELEASE_THRESHOLD, 0.27);

    return (1 + holdAddition) * holdFactor;
}

function strainValue(objects, totalColumns) {
    const individualStrains = new Array(totalColumns).fill(0);
    let highestIndividualStrain = 0;
    let overallStrain = 1;

    let currentSectionPeak = 0;
    let currentSectionEnd = 0;
    const peaks = [];

    for (const current of objects) {
        if (current.index === 0)
            currentSectionEnd = Math.ceil(current.startTime / SECTION_LENGTH) * SECTION_LENGTH;

        while (current.startTime > currentSectionEnd) {
            peaks.push(currentSectionPeak);

            const previous = objects[current.index - 1];
            const offset = currentSectionEnd - previous.startTime;

            // Strain.CalculateInitialStrain.
            currentSectionPeak = decay(highestIndividualStrain, offset, INDIVIDUAL_DECAY_BASE)
                + decay(overallStrain, offset, OVERALL_DECAY_BASE);

            currentSectionEnd += SECTION_LENGTH;
        }

        individualStrains[current.column] = decay(
            individualStrains[current.column],
            current.columnStrainTime,
            INDIVIDUAL_DECAY_BASE,
        );
        individualStrains[current.column] += individualStrainValue(current);

        // Notes in a chord (delta <= 1ms) use the hardest strain, so processing order
        // does not change the result.
        highestIndividualStrain = current.deltaTime <= 1
            ? Math.max(highestIndividualStrain, individualStrains[current.column])
            : individualStrains[current.column];

        overallStrain = decay(overallStrain, current.deltaTime, OVERALL_DECAY_BASE);
        overallStrain += overallStrainValue(current);

        // StrainDecaySkill.CurrentStrain after adding StrainValueOf.
        currentSectionPeak = Math.max(highestIndividualStrain + overallStrain, currentSectionPeak);
    }

    peaks.push(currentSectionPeak);

    let difficulty = 0;
    let weight = 1;

    for (const peak of peaks.filter(value => value > 0).sort((a, b) => b - a)) {
        difficulty += peak * weight;
        weight *= DECAY_WEIGHT;
    }

    return difficulty;
}

export function computeStarRating(map, { rate = 1 } = {}) {
    if (!map?.hits?.length || !map.keyCount) return 0;

    const objects = buildDifficultyObjects(map.hits, map.keyCount, rate);
    if (!objects.length) return 0;

    return strainValue(objects, map.keyCount) * DIFFICULTY_MULTIPLIER;
}
