import { CourseGraph } from '@/app/lib/courseGraph';
import { analyzeRequirementGaps, type GapAnalysisResult } from '@/app/lib/gapAnalysis';
import { loadGraphCourses } from '@/app/lib/loadCourses';
import type { MajorRequirements } from '@/app/lib/majorRequirementsTypes';
import type { RecommendationGapSummary } from '@/app/lib/recommendedSchedules';
import { annotateSchedule, type ScheduleAnnotations } from '@/app/lib/scheduleAnnotations';
import { recommendSchedule, type ScheduleRecommendation } from '@/app/lib/scheduleRecommender';
import { sanitizeAIInput } from '@/app/lib/validation';
import type { TranscriptCourseRow } from '@/app/lib/transcriptUtils';

let catalogGraph: CourseGraph | null | undefined;

export function loadCatalogPrereqGraph(): CourseGraph {
    if (catalogGraph) return catalogGraph;
    catalogGraph = new CourseGraph(loadGraphCourses());
    return catalogGraph;
}

export function resetCatalogPrereqGraph(): void {
    catalogGraph = undefined;
}

export function summarizeGaps(gaps: GapAnalysisResult): RecommendationGapSummary {
    return {
        remainingSlotCount: gaps.remainingSlots.length,
        remainingUnits: gaps.remainingSlots.reduce((sum, slot) => sum + slot.remainingUnits, 0),
        unitsEarned: gaps.unitsEarned,
        unitsInProgress: gaps.unitsInProgress,
        totalUnitsRequired: gaps.totalUnitsRequired,
    };
}

export interface BuildRecommendationInput {
    major: MajorRequirements;
    transcript: TranscriptCourseRow[];
    targetUnits?: number;
    careerGoal?: string;
    now?: Date;
    graph?: CourseGraph | null;
    annotate?: typeof annotateSchedule;
}

export interface BuiltRecommendation {
    schedule: ScheduleRecommendation;
    annotations: ScheduleAnnotations | null;
    gaps: GapAnalysisResult;
    gapSummary: RecommendationGapSummary;
}

export async function buildRecommendation(
    input: BuildRecommendationInput,
): Promise<BuiltRecommendation> {
    const graph = input.graph === undefined ? loadCatalogPrereqGraph() : input.graph;
    const gaps = analyzeRequirementGaps(input.major, input.transcript);
    const schedule = recommendSchedule(input.major, input.transcript, {
        targetUnits: input.targetUnits,
        now: input.now,
        graph,
    });

    const annotate = input.annotate ?? annotateSchedule;
    const careerGoal = input.careerGoal ? sanitizeAIInput(input.careerGoal, 400) : undefined;
    let annotations: ScheduleAnnotations | null = null;
    try {
        annotations = await annotate(schedule, {
            majorName: input.major.name,
            majorCode: input.major.code,
            careerGoal,
        });
    } catch (error) {
        console.warn('Recommendation annotation failed:', error instanceof Error ? error.message : error);
        annotations = null;
    }

    return {
        schedule,
        annotations,
        gaps,
        gapSummary: summarizeGaps(gaps),
    };
}
