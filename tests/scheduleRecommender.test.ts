import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    academicYearLabel,
    inferPlanningTerm,
    planningTermFromDate,
    termsInAcademicYear,
} from '../app/lib/academicTerms';
import { graphFromPrerequisiteMap } from '../app/lib/eligibility';
import { recommendSchedule } from '../app/lib/scheduleRecommender';
import type { MajorRequirements } from '../app/lib/majorRequirementsTypes';
import type { TranscriptCourseRow } from '../app/lib/transcriptUtils';
import type { PrerequisiteNode } from '../types';
import { SEMESTER_UNIT_MAX, SEMESTER_UNIT_MIN } from '../app/lib/recommenderConfig';

const here = dirname(fileURLToPath(import.meta.url));
const csMajor = JSON.parse(
    readFileSync(join(here, '..', 'data', 'majors', 'bs-cs-coscbs.json'), 'utf8'),
) as MajorRequirements;
const prereqs = JSON.parse(
    readFileSync(join(here, '..', 'data', 'coursePrerequisites.json'), 'utf8'),
).prerequisites as Record<string, PrerequisiteNode>;
const graph = graphFromPrerequisiteMap(prereqs);

function row(course: string, grade: string, credits = 3, term = 'Fall 2024'): TranscriptCourseRow {
    return { course, grade, credits, term, description: course };
}

test('Fall start schedules Fall and the following Spring', () => {
    const terms = termsInAcademicYear({ season: 'Fall', year: 2026 });
    assert.deepEqual(terms, [
        { season: 'Fall', year: 2026 },
        { season: 'Spring', year: 2027 },
    ]);
    assert.equal(academicYearLabel(terms), '2026-27');
});

test('Spring start schedules Spring only', () => {
    const terms = termsInAcademicYear({ season: 'Spring', year: 2027 });
    assert.deepEqual(terms, [{ season: 'Spring', year: 2027 }]);
    assert.equal(academicYearLabel(terms), '2026-27');
});

test('in-progress Winter infers Spring; calendar January infers Spring', () => {
    assert.deepEqual(inferPlanningTerm(['Winter 2027']), { season: 'Spring', year: 2027 });
    assert.deepEqual(planningTermFromDate(new Date('2027-01-15T12:00:00Z')), { season: 'Spring', year: 2027 });
    assert.deepEqual(planningTermFromDate(new Date('2026-09-01T12:00:00Z')), { season: 'Fall', year: 2026 });
});

test('in-progress Spring yields a single-term plan', () => {
    const plan = recommendSchedule(csMajor, [row('CSC 210', 'IP', 4, 'Spring 2026')], { graph, now: new Date('2026-01-15T00:00:00Z') });
    assert.equal(plan.terms.length, 1);
    assert.equal(plan.terms[0].label, 'Spring 2026');
    assert.ok(plan.terms[0].items.some((item) => item.courseId === 'CSC-210' && item.alreadyInProgress));
});

test('Fall plan includes Spring and stays within 12–19 units', () => {
    const plan = recommendSchedule(csMajor, [
        row('CSC 110', 'A', 4, 'Fall 2025'),
        row('MATH 125', 'A', 3, 'Fall 2025'),
        row('ENGL 101', 'A', 3, 'Fall 2025'),
    ], { graph, now: new Date('2026-09-01T00:00:00Z') });

    assert.equal(plan.terms.length, 2);
    assert.equal(plan.terms[0].label, 'Fall 2026');
    assert.equal(plan.terms[1].label, 'Spring 2027');
    for (const term of plan.terms) {
        assert.ok(term.units <= SEMESTER_UNIT_MAX, `${term.label} is ${term.units}`);
        assert.ok(term.units >= SEMESTER_UNIT_MIN || term.belowMinimum);
    }
    const fallIds = plan.terms[0].items.map((item) => item.courseId).filter(Boolean);
    assert.ok(fallIds.includes('CSC-120'));
    assert.ok(!fallIds.includes('CSC-110'));
});

test('MATH 129 is not scheduled in the same term before Calculus I', () => {
    const blocked = recommendSchedule(csMajor, [row('CSC 110', 'A', 4)], {
        graph,
        now: new Date('2026-09-01T00:00:00Z'),
    });
    const fallIds = blocked.terms[0].items.map((item) => item.courseId);
    assert.ok(!fallIds.includes('MATH-129'));

    const ready = recommendSchedule(csMajor, [
        row('CSC 110', 'A', 4),
        row('MATH 125', 'A', 3),
    ], { graph, now: new Date('2026-09-01T00:00:00Z') });
    const readyIds = ready.terms.flatMap((term) => term.items.map((item) => item.courseId));
    assert.ok(readyIds.includes('MATH-129'));
});

test('unknown catalog courses stay eligible and are tagged', () => {
    const plan = recommendSchedule(csMajor, [
        row('CSC 110', 'A', 4),
        row('CSC 120', 'A', 4),
        row('CSC 144', 'A', 3),
        row('CSC 210', 'A', 4),
        row('CSC 244', 'A', 3),
    ], { graph, now: new Date('2026-09-01T00:00:00Z') });
    const unknown = plan.terms.flatMap((term) => term.items).find((item) => item.prereqStatus === 'unknown');
    assert.ok(unknown, 'expected at least one PDF course not in the prereq graph');
    assert.ok(unknown.reason.includes('prereqs not in catalog'));
});

test('exclusive equivalents are not both scheduled', () => {
    const plan = recommendSchedule(csMajor, [], { graph, now: new Date('2026-09-01T00:00:00Z') });
    const ids = plan.terms.flatMap((term) => term.items.map((item) => item.courseId));
    const progI = ['CSC-110', 'ECE-101', 'ECE-175', 'ISTA-130'].filter((id) => ids.includes(id));
    assert.ok(progI.length <= 1);
});

test('GE buckets appear as unit placeholders, not invented courses', () => {
    const tiny: MajorRequirements = {
        id: 'tiny',
        code: 'TINY',
        name: 'Tiny',
        totalUnits: 30,
        groups: [
            {
                id: 'g1',
                name: 'Core',
                logic: 'all',
                slots: [{
                    id: 's1',
                    name: 'Only Course',
                    kind: 'courses',
                    minCourses: 1,
                    options: [{ courseId: 'CSC-110', units: 4, title: 'Programming I' }],
                }],
            },
            {
                id: 'g2',
                name: 'GE',
                logic: 'all',
                slots: [{
                    id: 'artist',
                    name: 'Artist',
                    kind: 'course_set',
                    minCourses: 1,
                    minUnits: 3,
                    options: [],
                    courseSetLabel: 'Artist Courses',
                }],
            },
        ],
    };

    const plan = recommendSchedule(tiny, [], { now: new Date('2026-09-01T00:00:00Z') });
    const ge = plan.terms[0].items.find((item) => item.kind === 'ge_bucket');
    assert.ok(ge);
    assert.equal(ge.title, 'Artist Courses');
    assert.equal(ge.units, 3);
    assert.equal(ge.courseId, undefined);
    assert.ok(plan.terms[0].units <= SEMESTER_UNIT_MAX);
});

test('never schedules past 19 units even with many 3-unit options', () => {
    const options = Array.from({ length: 10 }, (_, i) => ({
        courseId: `CSC-${300 + i}`,
        units: 3,
        title: `Course ${i}`,
    }));
    const major: MajorRequirements = {
        id: 'load',
        code: 'LOAD',
        name: 'Load',
        totalUnits: 120,
        groups: [{
            id: 'core',
            name: 'Core',
            logic: 'all',
            slots: [{
                id: 'many',
                name: 'Many',
                kind: 'courses',
                minCourses: 10,
                options,
            }],
        }],
    };
    const plan = recommendSchedule(major, [], { now: new Date('2026-09-01T00:00:00Z'), targetUnits: 19 });
    assert.ok(plan.terms[0].units <= 19);
    assert.ok(plan.terms[0].units >= 18);
});
