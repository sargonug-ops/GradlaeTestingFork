import type { CompletedCourse, PrerequisiteNode } from '@/types';
import { normalizeCourseCode } from '@/app/lib/courseCodes';
import {
    academicYearLabel,
    formatTerm,
    inferPlanningTerm,
    parseTermLabel,
    termsInAcademicYear,
    type AcademicTerm,
} from '@/app/lib/academicTerms';
import { analyzeRequirementGaps, type GapAnalysisResult, type SlotGap } from '@/app/lib/gapAnalysis';
import { evaluateEligibility, unlockCount, type PrereqStatus } from '@/app/lib/eligibility';
import type { CourseGraph } from '@/app/lib/courseGraph';
import type { MajorCourseOption, MajorRequirements } from '@/app/lib/majorRequirementsTypes';
import {
    SEMESTER_UNIT_DEFAULT,
    SEMESTER_UNIT_MAX,
    SEMESTER_UNIT_MIN,
} from '@/app/lib/recommenderConfig';
import {
    isInProgressGrade,
    transcriptCoursesToCompleted,
    type TranscriptCourseRow,
} from '@/app/lib/transcriptUtils';

export interface ScheduledItem {
    kind: 'course' | 'ge_bucket';
    courseId?: string;
    title: string;
    units: number;
    slotIds: string[];
    slotName: string;
    reason: string;
    prereqStatus: PrereqStatus | 'not_applicable';
    alreadyInProgress?: boolean;
}

export interface TermSchedule {
    term: AcademicTerm;
    label: string;
    items: ScheduledItem[];
    units: number;
    belowMinimum: boolean;
    atMaximum: boolean;
}

export interface UnscheduledRequirement {
    slotId: string;
    name: string;
    kind: SlotGap['kind'];
    remainingCourses: number;
    remainingUnits: number;
    courseSetLabel?: string;
}

export interface ScheduleRecommendation {
    academicYear: string;
    planningStart: AcademicTerm;
    targetUnits: number;
    terms: TermSchedule[];
    unscheduled: UnscheduledRequirement[];
}

export interface RecommendScheduleOptions {
    now?: Date;
    targetUnits?: number;
    graph?: CourseGraph | null;
    prereqs?: Record<string, PrerequisiteNode>;
}

function clampTarget(units: number): number {
    return Math.min(SEMESTER_UNIT_MAX, Math.max(SEMESTER_UNIT_MIN, Math.round(units)));
}

function optionLookup(major: MajorRequirements): Map<string, MajorCourseOption> {
    const map = new Map<string, MajorCourseOption>();
    for (const group of major.groups) {
        for (const slot of group.slots) {
            for (const option of slot.options) {
                const id = normalizeCourseCode(option.courseId) || option.courseId;
                if (!map.has(id)) map.set(id, { ...option, courseId: id });
            }
        }
    }
    return map;
}

function exclusivePartners(major: MajorRequirements, courseId: string): string[] {
    const id = normalizeCourseCode(courseId) || courseId;
    for (const set of major.exclusiveSets || []) {
        const members = set.courseIds.map((entry) => normalizeCourseCode(entry) || entry);
        if (members.includes(id)) return members;
    }
    return [id];
}

function slotsForCourse(gaps: GapAnalysisResult, courseId: string): SlotGap[] {
    const id = normalizeCourseCode(courseId) || courseId;
    return gaps.remainingSlots.filter((slot) =>
        slot.remainingOptions.some((option) => (normalizeCourseCode(option) || option) === id),
    );
}

function catalogLevel(courseId: string): number {
    const number = courseId.split('-')[1] || '';
    const match = number.match(/^(\d{3})/);
    return match ? parseInt(match[1], 10) : 0;
}

function subjectOf(courseId: string): string {
    return courseId.split('-')[0] || '';
}

function blockedByUnknownSequence(
    courseId: string,
    prereqStatus: PrereqStatus,
    termItems: ScheduledItem[],
): boolean {
    if (prereqStatus !== 'unknown') return false;
    const subject = subjectOf(courseId);
    const level = catalogLevel(courseId);
    return termItems.some((item) => {
        if (!item.courseId) return false;
        if (subjectOf(item.courseId) !== subject) return false;
        const otherLevel = catalogLevel(item.courseId);
        return otherLevel < level && level - otherLevel >= 10;
    });
}

function completedThrough(
    transcript: TranscriptCourseRow[],
    beforeTerm: AcademicTerm | null,
): CompletedCourse[] {
    const passing = transcriptCoursesToCompleted(transcript);
    if (!beforeTerm) return passing;

    const extras = transcriptCoursesToCompleted(transcript, { includeInProgress: true })
        .filter((course) => {
            if (!isInProgressGrade(course.grade)) return false;
            const parsed = parseTermLabel(`${course.term} ${course.year}`.trim())
                || parseTermLabel(course.semester);
            if (!parsed) return true;
            if (parsed.season !== 'Fall' && parsed.season !== 'Spring') return true;
            const key = parsed.year * 2 + (parsed.season === 'Spring' ? 1 : 0);
            const beforeKey = beforeTerm.year * 2 + (beforeTerm.season === 'Spring' ? 1 : 0);
            return key < beforeKey;
        });

    const byId = new Map(passing.map((course) => [course.courseId, course]));
    for (const course of extras) {
        if (!byId.has(course.courseId)) {
            byId.set(course.courseId, { ...course, grade: 'C' });
        }
    }
    return Array.from(byId.values());
}

function inProgressForTerm(transcript: TranscriptCourseRow[], term: AcademicTerm): TranscriptCourseRow[] {
    const label = formatTerm(term);
    return transcript.filter((row) => {
        if (!isInProgressGrade(row.grade)) return false;
        const parsed = parseTermLabel(row.term);
        return parsed?.season === term.season && parsed.year === term.year || row.term === label;
    });
}

function geSlots(gaps: GapAnalysisResult): SlotGap[] {
    return gaps.remainingSlots.filter((slot) => {
        if (slot.kind === 'milestone') return false;
        if (slot.chosen === false) return false;
        return slot.kind === 'course_set';
    });
}

function scoreCandidate(
    courseId: string,
    slots: SlotGap[],
    remainingIds: string[],
    graph: CourseGraph | null | undefined,
): number {
    const singleton = slots.some((slot) => slot.requiredCourses === 1 && slot.remainingCourses >= 1);
    const unlocks = unlockCount(courseId, remainingIds, graph);
    return (singleton ? 1000 : 0) + slots.length * 40 + unlocks * 25 - catalogLevel(courseId);
}

function itemFromCourse(
    courseId: string,
    option: MajorCourseOption | undefined,
    slots: SlotGap[],
    eligibility: { prereqStatus: PrereqStatus; missing: string[] },
    alreadyInProgress: boolean,
): ScheduledItem {
    const slotName = slots[0]?.name || 'Major requirement';
    const units = option?.units && option.units > 0 ? option.units : 3;
    const title = option?.title || courseId;
    const reasons = [`Fills ${slotName}`];
    if (eligibility.prereqStatus === 'unknown') {
        reasons.push('prereqs not in catalog');
    } else if (eligibility.prereqStatus === 'met') {
        reasons.push('prerequisites met');
    }
    if (alreadyInProgress) reasons.push('already in progress');
    return {
        kind: 'course',
        courseId,
        title,
        units,
        slotIds: slots.map((slot) => slot.slotId),
        slotName,
        reason: reasons.join(' · '),
        prereqStatus: eligibility.prereqStatus,
        alreadyInProgress,
    };
}

function geItem(slot: SlotGap): ScheduledItem {
    const units = slot.remainingUnits > 0 ? slot.remainingUnits : (slot.remainingCourses > 0 ? slot.remainingCourses * 3 : 3);
    const title = slot.courseSetLabel || slot.name;
    return {
        kind: 'ge_bucket',
        title,
        units,
        slotIds: [slot.slotId],
        slotName: slot.name,
        reason: `${title} still needed · ${units} units (no course list on the degree PDF)`,
        prereqStatus: 'not_applicable',
    };
}

export function recommendSchedule(
    major: MajorRequirements,
    transcript: TranscriptCourseRow[],
    options: RecommendScheduleOptions = {},
): ScheduleRecommendation {
    const targetUnits = clampTarget(options.targetUnits ?? SEMESTER_UNIT_DEFAULT);
    const graph = options.graph ?? null;
    const optionsById = optionLookup(major);

    const ipTerms = transcript.filter((row) => isInProgressGrade(row.grade)).map((row) => row.term);
    const start = inferPlanningTerm(ipTerms, options.now);
    const terms = termsInAcademicYear(start);

    const working: TranscriptCourseRow[] = [...transcript];
    const scheduledIds = new Set<string>();
    const termSchedules: TermSchedule[] = [];
    const placedGe = new Set<string>();

    for (const term of terms) {
        const items: ScheduledItem[] = [];
        let units = 0;

        for (const row of inProgressForTerm(transcript, term)) {
            const courseId = normalizeCourseCode(row.course);
            if (!courseId || scheduledIds.has(courseId)) continue;
            scheduledIds.add(courseId);
            exclusivePartners(major, courseId).forEach((id) => scheduledIds.add(id));
            const gaps = analyzeRequirementGaps(major, working);
            const slots = slotsForCourse(gaps, courseId);
            const item = itemFromCourse(
                courseId,
                optionsById.get(courseId),
                slots,
                { prereqStatus: 'met', missing: [] },
                true,
            );
            item.units = row.credits > 0 ? row.credits : item.units;
            items.push(item);
            units += item.units;
        }

        const completed = completedThrough(working, term);

        while (units < targetUnits) {
            const gaps = analyzeRequirementGaps(major, working);
            const remainingIds = [...new Set(gaps.remainingSlots.flatMap((slot) => slot.remainingOptions))]
                .map((id) => normalizeCourseCode(id) || id)
                .filter((id) => !scheduledIds.has(id));

            let best: { courseId: string; score: number; slots: SlotGap[]; eligibility: ReturnType<typeof evaluateEligibility> } | null = null;

            for (const courseId of remainingIds) {
                const option = optionsById.get(courseId);
                const courseUnits = option?.units && option.units > 0 ? option.units : 3;
                if (units + courseUnits > SEMESTER_UNIT_MAX) continue;

                const eligibility = evaluateEligibility(courseId, completed, graph);
                if (!eligibility.eligible) continue;
                if (blockedByUnknownSequence(courseId, eligibility.prereqStatus, items)) continue;

                const slots = slotsForCourse(gaps, courseId);
                if (slots.length === 0) continue;

                const score = scoreCandidate(courseId, slots, remainingIds, graph);
                if (!best || score > best.score) {
                    best = { courseId, score, slots, eligibility };
                }
            }

            if (!best) break;

            const option = optionsById.get(best.courseId);
            const item = itemFromCourse(best.courseId, option, best.slots, best.eligibility, false);
            if (units + item.units > SEMESTER_UNIT_MAX) break;

            items.push(item);
            units += item.units;
            scheduledIds.add(best.courseId);
            exclusivePartners(major, best.courseId).forEach((id) => scheduledIds.add(id));
            working.push({
                course: best.courseId.replace('-', ' '),
                grade: 'IP',
                credits: item.units,
                term: formatTerm(term),
                description: item.title,
            });
        }

        if (units < SEMESTER_UNIT_MIN) {
            const gaps = analyzeRequirementGaps(major, working);
            for (const slot of geSlots(gaps)) {
                if (placedGe.has(slot.slotId)) continue;
                const item = geItem(slot);
                if (units + item.units > SEMESTER_UNIT_MAX) continue;
                items.push(item);
                units += item.units;
                placedGe.add(slot.slotId);
                if (units >= SEMESTER_UNIT_MIN) break;
            }
        }

        termSchedules.push({
            term,
            label: formatTerm(term),
            items,
            units,
            belowMinimum: units < SEMESTER_UNIT_MIN,
            atMaximum: units >= SEMESTER_UNIT_MAX,
        });
    }

    const finalGaps = analyzeRequirementGaps(major, working);
    const unscheduled: UnscheduledRequirement[] = finalGaps.remainingSlots
        .filter((slot) => slot.kind !== 'milestone' && slot.chosen !== false)
        .filter((slot) => !placedGe.has(slot.slotId))
        .filter((slot) => slot.status === 'remaining' || slot.status === 'partial' || slot.status === 'in_progress')
        .map((slot) => ({
            slotId: slot.slotId,
            name: slot.name,
            kind: slot.kind,
            remainingCourses: slot.remainingCourses,
            remainingUnits: slot.remainingUnits,
            courseSetLabel: slot.courseSetLabel,
        }));

    return {
        academicYear: academicYearLabel(terms),
        planningStart: start,
        targetUnits,
        terms: termSchedules,
        unscheduled,
    };
}

export { clampTarget as clampSemesterTarget };
