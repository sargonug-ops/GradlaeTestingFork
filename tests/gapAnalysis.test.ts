import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { normalizeCourseCode } from '../app/lib/courseCodes';
import {
    MAX_SAVED_PLANNERS,
    SEMESTER_UNIT_DEFAULT,
    SEMESTER_UNIT_MAX,
    SEMESTER_UNIT_MIN,
} from '../app/lib/recommenderConfig';
import { loadAllMajors, loadMajorById, resetMajorCache } from '../app/lib/majorRequirements';
import type { MajorRequirements } from '../app/lib/majorRequirementsTypes';
import {
    analyzeRequirementGaps,
    remainingCandidateCourses,
} from '../app/lib/gapAnalysis';
import type { TranscriptCourseRow } from '../app/lib/transcriptUtils';

const here = dirname(fileURLToPath(import.meta.url));
const csMajor = JSON.parse(
    readFileSync(join(here, '..', 'data', 'majors', 'bs-cs-coscbs.json'), 'utf8'),
) as MajorRequirements;
const chemMajor = JSON.parse(
    readFileSync(join(here, '..', 'data', 'majors', 'bs-chem-chembs.json'), 'utf8'),
) as MajorRequirements;

function row(course: string, grade: string, credits = 3, term = 'Fall 2024'): TranscriptCourseRow {
    return { course, grade, credits, term, description: course };
}

function slot(result: ReturnType<typeof analyzeRequirementGaps>, id: string) {
    const found = result.slots.find((entry) => entry.slotId === id);
    assert.ok(found, `expected slot ${id}`);
    return found;
}

test('loads both ingested majors from data/majors', () => {
    resetMajorCache();
    const ids = loadAllMajors().map((major) => major.id).sort();
    assert.deepEqual(ids, ['bs-chem-chembs', 'bs-cs-coscbs']);
    assert.equal(loadMajorById('bs-cs-coscbs')?.code, 'COSCBS');
});

test('recommender unit and planner caps match the product rules', () => {
    assert.equal(SEMESTER_UNIT_MIN, 12);
    assert.equal(SEMESTER_UNIT_MAX, 19);
    assert.equal(SEMESTER_UNIT_DEFAULT, 15);
    assert.ok(SEMESTER_UNIT_DEFAULT >= SEMESTER_UNIT_MIN);
    assert.ok(SEMESTER_UNIT_DEFAULT <= SEMESTER_UNIT_MAX);
    assert.equal(MAX_SAVED_PLANNERS, 5);
});

test('normalizes UAccess codes including glued PDF forms and HIST 150C3', () => {
    assert.equal(normalizeCourseCode('CSC110'), 'CSC-110');
    assert.equal(normalizeCourseCode('CSC 110'), 'CSC-110');
    assert.equal(normalizeCourseCode('HIST150C3'), 'HIST-150C3');
    assert.equal(normalizeCourseCode('HIST 150C3'), 'HIST-150C3');
});

test('empty transcript leaves CS major slots remaining', () => {
    const result = analyzeRequirementGaps(csMajor, []);
    assert.equal(result.majorCode, 'COSCBS');
    assert.ok(result.remainingSlots.length > 10);
    assert.equal(slot(result, 'R1299/L30').status, 'remaining');
    assert.equal(slot(result, 'R15831/L5').status, 'remaining');
});

test('CS foundations and calculus match from a transcript', () => {
    const result = analyzeRequirementGaps(csMajor, [
        row('CSC 110', 'A', 4),
        row('CSC 120', 'B', 4),
        row('CSC 144', 'A', 3),
        row('MATH 125', 'A', 3),
        row('MATH 129', 'B', 3),
        row('UNIV 101', 'A', 1),
        row('ENGL 101', 'A', 3),
        row('ENGL 102', 'A', 3),
        row('HIST 150C3', 'A', 3),
        row('CHEM 151', 'A', 4),
        row('PHYS 141', 'B', 4),
    ]);

    assert.equal(slot(result, 'R1299/L30').status, 'satisfied');
    assert.equal(slot(result, 'R1299/L40').status, 'satisfied');
    assert.equal(slot(result, 'R1299/L50').status, 'satisfied');
    assert.equal(slot(result, 'R15831/L5').status, 'satisfied');
    assert.equal(slot(result, 'R15831/L10').status, 'satisfied');
    assert.equal(slot(result, 'R16657/L10').status, 'satisfied');
    assert.equal(slot(result, 'R532/L10').status, 'satisfied');
    assert.equal(slot(result, 'R532/L10').chosen, true);
    assert.equal(slot(result, 'R532/L20').chosen, false);
    assert.equal(slot(result, 'R17271/L10').status, 'satisfied');
    assert.equal(slot(result, 'R15829/L10').status, 'satisfied');
    assert.equal(slot(result, 'R15829/L30').status, 'satisfied');
    assert.equal(slot(result, 'R1299/L80').status, 'satisfied');
    assert.ok(!result.remainingSlots.some((entry) => entry.slotId === 'R1299/L30'));
});

test('only one of CSC 110 and ECE 101 counts toward Programming I', () => {
    const result = analyzeRequirementGaps(csMajor, [
        row('CSC 110', 'A', 4),
        row('ECE 101', 'A', 4),
    ]);
    const programmingI = slot(result, 'R1299/L30');
    assert.equal(programmingI.status, 'satisfied');
    assert.equal(programmingI.matchedCourseIds.length, 1);
    assert.ok(
        programmingI.matchedCourseIds[0] === 'CSC-110' || programmingI.matchedCourseIds[0] === 'ECE-101',
    );
});

test('in-progress CSC 210 is flagged rather than fully satisfied', () => {
    const result = analyzeRequirementGaps(csMajor, [row('CSC 210', 'IP', 4, 'Spring 2026')]);
    const software = slot(result, 'R1299/L70');
    assert.equal(software.status, 'in_progress');
    assert.deepEqual(software.matchedCourseIds, ['CSC-210']);
    assert.ok(result.remainingSlots.some((entry) => entry.slotId === 'R1299/L70'));
});

test('unnamed GE course sets are not filled by unrelated transcript courses', () => {
    const result = analyzeRequirementGaps(csMajor, [row('MUS 101', 'A', 3)]);
    assert.equal(slot(result, 'R16656/L10').status, 'remaining');
    assert.equal(slot(result, 'R16656/L10').filledCourses, 0);
    assert.deepEqual(result.unusedTranscriptCourses, ['MUS-101']);
});

test('remaining candidate courses come only from the PDF option lists', () => {
    const result = analyzeRequirementGaps(csMajor, [row('CSC 110', 'A', 4)]);
    const candidates = remainingCandidateCourses(result);
    assert.ok(candidates.includes('CSC-120'));
    assert.ok(candidates.includes('CSC-210'));
    assert.ok(!candidates.includes('MUS-101'));
});

test('Chemistry organic chemistry chooses the matching sequence', () => {
    const oneCourse = analyzeRequirementGaps(chemMajor, [row('CHEM 246', 'B', 3)]);
    assert.equal(slot(oneCourse, 'R1148/L10').status, 'satisfied');
    assert.equal(slot(oneCourse, 'R1148/L10').chosen, true);
    assert.equal(slot(oneCourse, 'R1148/L20').chosen, false);

    const twoCourse = analyzeRequirementGaps(chemMajor, [
        row('CHEM 241A', 'A', 3),
        row('CHEM 241B', 'A', 3),
    ]);
    assert.equal(slot(twoCourse, 'R1148/L20').status, 'satisfied');
    assert.equal(slot(twoCourse, 'R1148/L20').chosen, true);
});

test('Chemistry calculus I exclusive set does not consume both 122B and 125', () => {
    const result = analyzeRequirementGaps(chemMajor, [
        row('MATH 122B', 'A', 4),
        row('MATH 125', 'A', 3),
        row('MATH 129', 'B', 3),
    ]);
    const calcI = slot(result, 'R1145/L10A');
    assert.equal(calcI.status, 'satisfied');
    assert.equal(calcI.matchedCourseIds.length, 1);
    assert.equal(slot(result, 'R1145/L10B').status, 'satisfied');
});
