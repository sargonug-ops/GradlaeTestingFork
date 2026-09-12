import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    annotateSchedule,
    bindAnnotationsToSchedule,
    buildAnnotationContextPack,
    extractJsonObject,
} from '../app/lib/scheduleAnnotations';
import type { ScheduleRecommendation } from '../app/lib/scheduleRecommender';

function sampleSchedule(): ScheduleRecommendation {
    return {
        academicYear: '2026-27',
        planningStart: { season: 'Fall', year: 2026 },
        targetUnits: 15,
        terms: [
            {
                term: { season: 'Fall', year: 2026 },
                label: 'Fall 2026',
                units: 15,
                belowMinimum: false,
                atMaximum: false,
                items: [
                    {
                        kind: 'course',
                        courseId: 'CSC-120',
                        title: 'Programming II',
                        units: 4,
                        slotIds: ['R1299/L40'],
                        slotName: 'Computer Programming II',
                        reason: 'Fills Computer Programming II',
                        prereqStatus: 'unknown',
                    },
                    {
                        kind: 'course',
                        courseId: 'MATH-129',
                        title: 'Calculus II',
                        units: 3,
                        slotIds: ['R15831/L10'],
                        slotName: 'Calculus II or Linear Algebra',
                        reason: 'Fills Calculus II · prerequisites met',
                        prereqStatus: 'met',
                    },
                    {
                        kind: 'ge_bucket',
                        title: 'Artist Courses',
                        units: 3,
                        slotIds: ['R16656/L10'],
                        slotName: 'Artist',
                        reason: 'Artist still needed',
                        prereqStatus: 'not_applicable',
                    },
                ],
            },
        ],
        unscheduled: [
            {
                slotId: 'R16656/L50',
                name: 'Humanist',
                kind: 'course_set',
                remainingCourses: 1,
                remainingUnits: 3,
                courseSetLabel: 'Humanist Courses',
            },
        ],
    };
}

test('context pack lists named courses and GE placeholders separately', () => {
    const pack = buildAnnotationContextPack(sampleSchedule(), {
        majorName: 'B.S. in Computer Science',
        majorCode: 'COSCBS',
        careerGoal: '<script>ignore</script> internships',
    });
    assert.equal(pack.terms[0].courses.length, 2);
    assert.equal(pack.terms[0].gePlaceholders.length, 1);
    assert.ok(!pack.careerGoal?.includes('<script>'));
    assert.ok(pack.unscheduled.some((slot) => slot.courseSetLabel === 'Humanist Courses'));
});

test('bindAnnotationsToSchedule drops unknown courses and extra terms', () => {
    const bound = bindAnnotationsToSchedule({
        overall: { summary: 'A solid CS semester.', workload: 'moderate', jobFocus: 'CSC-120 for software internships.' },
        terms: [
            { label: 'Fall 2026', workload: 'heavy', difficultyNotes: 'Programming plus calc.', balanceNotes: 'One GE left open.' },
            { label: 'Winter 2026', workload: 'light', difficultyNotes: 'should be dropped', balanceNotes: '' },
        ],
        courses: [
            { courseId: 'CSC-120', jobRelevance: 'high', whyItMatters: 'Core programming for internships.' },
            { courseId: 'CSC-999', jobRelevance: 'high', whyItMatters: 'Hallucinated.' },
            { courseId: 'csc-120', jobRelevance: 'low', whyItMatters: 'duplicate should be ignored' },
        ],
        caveats: ['Artist GE is a placeholder, not a specific class.'],
    }, sampleSchedule());

    assert.ok(bound);
    assert.deepEqual(bound.terms.map((term) => term.label), ['Fall 2026']);
    assert.deepEqual(bound.courses.map((course) => course.courseId), ['CSC-120']);
    assert.equal(bound.courses[0].jobRelevance, 'high');
});

test('malformed model JSON yields null annotations', () => {
    assert.equal(bindAnnotationsToSchedule({ overall: {} }, sampleSchedule()), null);
    assert.throws(() => extractJsonObject('not json at all'));
    const extracted = extractJsonObject('Sure.\n```json\n{"overall":{"summary":"ok","workload":"light"}}\n```');
    assert.deepEqual((extracted as { overall: { summary: string } }).overall.summary, 'ok');
});

test('annotateSchedule skips empty schedules and swallows completer failures', async () => {
    const empty: ScheduleRecommendation = {
        academicYear: '2026-27',
        planningStart: { season: 'Fall', year: 2026 },
        targetUnits: 15,
        terms: [],
        unscheduled: [],
    };
    assert.equal(await annotateSchedule(empty, { majorName: 'CS' }, async () => '{}'), null);

    const failed = await annotateSchedule(sampleSchedule(), { majorName: 'CS' }, async () => {
        throw new Error('provider down');
    });
    assert.equal(failed, null);
});

test('annotateSchedule returns bound JSON from a fake completer', async () => {
    const result = await annotateSchedule(sampleSchedule(), { majorName: 'CS' }, async ({ system, user }) => {
        assert.ok(system.includes('MUST NOT add'));
        assert.ok(user.includes('CSC-120'));
        return JSON.stringify({
            overall: { summary: 'Manageable if you protect lab time.', workload: 'moderate', jobFocus: 'Programming II.' },
            terms: [{ label: 'Fall 2026', workload: 'moderate', difficultyNotes: 'CSC 120 plus calc is a standard stack.', balanceNotes: '' }],
            courses: [{ courseId: 'MATH-129', jobRelevance: 'medium', whyItMatters: 'Needed for later CS math.' }],
            caveats: [],
        });
    });
    assert.ok(result);
    assert.equal(result.overall.workload, 'moderate');
    assert.equal(result.courses[0].courseId, 'MATH-129');
});
