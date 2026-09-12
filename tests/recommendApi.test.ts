import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { graphFromPrerequisiteMap } from '../app/lib/eligibility';
import type { MajorRequirements } from '../app/lib/majorRequirementsTypes';
import { overflowIdsNewestFirst } from '../app/lib/recommendedSchedules';
import { buildRecommendation, summarizeGaps } from '../app/lib/recommendPipeline';
import { MAX_SAVED_PLANNERS } from '../app/lib/recommenderConfig';
import { toTranscriptCourseRows } from '../app/lib/transcriptUtils';
import { recommendRequestSchema, validateBody } from '../app/lib/validation';
import { analyzeRequirementGaps } from '../app/lib/gapAnalysis';
import type { PrerequisiteNode } from '../types';

const here = dirname(fileURLToPath(import.meta.url));
const csMajor = JSON.parse(
    readFileSync(join(here, '..', 'data', 'majors', 'bs-cs-coscbs.json'), 'utf8'),
) as MajorRequirements;
const prereqs = JSON.parse(
    readFileSync(join(here, '..', 'data', 'coursePrerequisites.json'), 'utf8'),
).prerequisites as Record<string, PrerequisiteNode>;
const graph = graphFromPrerequisiteMap(prereqs);

test('overflowIdsNewestFirst keeps the newest max and evicts the rest', () => {
    const ids = ['new', 'a', 'b', 'c', 'd', 'oldest'];
    assert.deepEqual(overflowIdsNewestFirst(ids, 5), ['oldest']);
    assert.deepEqual(overflowIdsNewestFirst(ids.slice(0, 5), MAX_SAVED_PLANNERS), []);
    assert.deepEqual(overflowIdsNewestFirst(['only'], 5), []);
});

test('toTranscriptCourseRows maps stored courseNumber/courseName rows', () => {
    const rows = toTranscriptCourseRows([
        { courseNumber: 'CSC 120', courseName: 'Programming II', grade: 'A', credits: '4', term: 'Fall 2024' },
        { course: 'MATH-129', description: 'Calc II', grade: 'B', credits: 3, term: 'Spring 2025', bestGrade: 'B' },
        { grade: 'A', credits: 3, term: 'Fall 2024' },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].course, 'CSC 120');
    assert.equal(rows[0].description, 'Programming II');
    assert.equal(rows[0].credits, 4);
    assert.equal(rows[1].course, 'MATH-129');
    assert.equal(rows[1].bestGrade, 'B');
});

test('recommendRequestSchema requires majorId and accepts stored transcript shape', () => {
    const missing = validateBody(recommendRequestSchema, { transcript: [] });
    assert.equal(missing.success, false);

    const ok = validateBody(recommendRequestSchema, {
        majorId: 'bs-cs-coscbs',
        targetUnits: 15,
        save: false,
        now: '2026-09-01T00:00:00.000Z',
        transcript: [
            { courseNumber: 'CSC-110', courseName: 'Intro', grade: 'A', credits: 4, term: 'Fall 2024' },
        ],
    });
    assert.equal(ok.success, true);
});

test('buildRecommendation runs A+B and uses annotations when the LLM succeeds', async () => {
    const transcript = [
        { course: 'CSC-110', grade: 'A', credits: 4, term: 'Fall 2024', description: 'Intro' },
        { course: 'MATH-122B', grade: 'B', credits: 4, term: 'Fall 2024', description: 'Calc I' },
    ];
    const built = await buildRecommendation({
        major: csMajor,
        transcript,
        targetUnits: 15,
        now: new Date('2026-09-01T00:00:00.000Z'),
        graph,
        annotate: async (schedule) => ({
            overall: { summary: 'Solid start', workload: 'moderate', jobFocus: 'software' },
            terms: schedule.terms.map((term) => ({
                label: term.label,
                workload: 'moderate' as const,
                difficultyNotes: '',
                balanceNotes: '',
            })),
            courses: [],
            caveats: [],
        }),
    });

    assert.ok(built.schedule.terms.length >= 1);
    assert.equal(built.annotations?.overall.summary, 'Solid start');
    assert.deepEqual(built.gapSummary, summarizeGaps(analyzeRequirementGaps(csMajor, transcript)));
});

test('buildRecommendation still returns a schedule when annotation throws', async () => {
    const built = await buildRecommendation({
        major: csMajor,
        transcript: [
            { course: 'CSC-110', grade: 'A', credits: 4, term: 'Fall 2024' },
        ],
        now: new Date('2026-09-01T00:00:00.000Z'),
        graph,
        annotate: async () => {
            throw new Error('LLM down');
        },
    });

    assert.equal(built.annotations, null);
    assert.ok(built.schedule.terms.length >= 1);
});
