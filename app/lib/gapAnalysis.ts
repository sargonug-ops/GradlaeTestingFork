import { normalizeCourseCode } from '@/app/lib/courseCodes';
import {
    isInProgressGrade,
    isPassingGrade,
    transcriptCoursesToCompleted,
    type TranscriptCourseRow,
} from '@/app/lib/transcriptUtils';
import type {
    ExclusiveSet,
    MajorCourseOption,
    MajorRequirements,
    RequirementGroup,
    RequirementSlot,
    SlotStatus,
} from '@/app/lib/majorRequirementsTypes';

export interface MatchableCourse {
    courseId: string;
    units: number;
    source: 'completed' | 'in_progress';
    originalCode: string;
}

export interface SlotGap {
    slotId: string;
    groupId: string;
    groupName: string;
    name: string;
    kind: RequirementSlot['kind'];
    status: SlotStatus;
    requiredCourses: number;
    requiredUnits: number;
    filledCourses: number;
    filledUnits: number;
    remainingCourses: number;
    remainingUnits: number;
    matchedCourseIds: string[];
    remainingOptions: string[];
    courseSetLabel?: string;
    notes?: string;
    chosen?: boolean;
}

export interface GapAnalysisResult {
    majorId: string;
    majorName: string;
    majorCode: string;
    totalUnitsRequired: number;
    unitsEarned: number;
    unitsInProgress: number;
    slots: SlotGap[];
    remainingSlots: SlotGap[];
    unusedTranscriptCourses: string[];
}

const WRIT_ENGL_ALIASES: Record<string, string[]> = {
    'WRIT-101': ['ENGL-101'],
    'WRIT-101A': ['ENGL-101A'],
    'WRIT-102': ['ENGL-102'],
    'WRIT-106': ['ENGL-106'],
    'WRIT-107': ['ENGL-107'],
    'WRIT-108': ['ENGL-108'],
    'WRIT-109H': ['ENGL-109H'],
    'ENGL-101': ['WRIT-101'],
    'ENGL-101A': ['WRIT-101A'],
    'ENGL-102': ['WRIT-102'],
    'ENGL-107': ['WRIT-107'],
    'ENGL-108': ['WRIT-108'],
    'ENGL-109H': ['WRIT-109H'],
};

function catalogLevel(courseId: string): number {
    const number = courseId.split('-')[1] || '';
    const match = number.match(/^(\d{3})/);
    return match ? parseInt(match[1], 10) : 0;
}

function subjectOf(courseId: string): string {
    return courseId.split('-')[0] || '';
}

export function equivalentCourseIds(courseId: string): string[] {
    const normalized = normalizeCourseCode(courseId);
    if (!normalized) return [];
    const aliases = WRIT_ENGL_ALIASES[normalized] || [];
    return [normalized, ...aliases];
}

function idsOverlap(a: string, b: string): boolean {
    const left = new Set(equivalentCourseIds(a));
    return equivalentCourseIds(b).some((id) => left.has(id));
}

function optionUnits(option: MajorCourseOption, transcriptUnits?: number): number {
    if (transcriptUnits && transcriptUnits > 0) return transcriptUnits;
    if (option.units && option.units > 0) return option.units;
    return 3;
}

function requiredCourses(slot: RequirementSlot): number {
    return slot.minCourses ?? 0;
}

function requiredUnits(slot: RequirementSlot): number {
    return slot.minUnits ?? 0;
}

function slotIsMet(slot: RequirementSlot, filledCourses: number, filledUnits: number): boolean {
    if (slot.kind === 'milestone') return false;
    const coursesNeeded = requiredCourses(slot);
    const unitsNeeded = requiredUnits(slot);
    if (coursesNeeded === 0 && unitsNeeded === 0) {
        return slot.kind === 'course_set' ? false : filledCourses > 0;
    }
    const coursesOk = coursesNeeded === 0 || filledCourses >= coursesNeeded;
    const unitsOk = unitsNeeded === 0 || filledUnits + 1e-9 >= unitsNeeded;
    return coursesOk && unitsOk;
}

function remainingFor(slot: RequirementSlot, filledCourses: number, filledUnits: number): { courses: number; units: number } {
    return {
        courses: Math.max(0, requiredCourses(slot) - filledCourses),
        units: Math.max(0, requiredUnits(slot) - filledUnits),
    };
}

function matchesSelectionRule(slot: RequirementSlot, courseId: string): boolean {
    const rule = slot.selectionRule;
    if (!rule) return false;
    if (rule.subject && subjectOf(courseId) !== rule.subject) return false;
    if (rule.minLevel && catalogLevel(courseId) < rule.minLevel) return false;
    return true;
}

function optionMatchesCourse(option: MajorCourseOption, courseId: string): boolean {
    return idsOverlap(option.courseId, courseId);
}

interface MatchState {
    all: MatchableCourse[];
    consumed: Set<string>;
    exclusiveLocked: Map<string, string>;
    exclusiveSets: ExclusiveSet[];
}

function exclusiveSetFor(courseId: string, sets: ExclusiveSet[]): ExclusiveSet | undefined {
    return sets.find((set) => set.courseIds.some((id) => idsOverlap(id, courseId)));
}

function isBlockedByExclusive(courseId: string, state: MatchState): boolean {
    const set = exclusiveSetFor(courseId, state.exclusiveSets);
    if (!set) return false;
    const locked = state.exclusiveLocked.get(set.id);
    if (!locked) return false;
    return !idsOverlap(locked, courseId);
}

function lockExclusive(courseId: string, state: MatchState): void {
    const set = exclusiveSetFor(courseId, state.exclusiveSets);
    if (!set) return;
    if (!state.exclusiveLocked.has(set.id)) {
        const canonical = set.courseIds.find((id) => idsOverlap(id, courseId)) || courseId;
        state.exclusiveLocked.set(set.id, canonical);
    }
}

function markConsumed(courseId: string, consumed: Set<string>): void {
    for (const id of equivalentCourseIds(courseId)) consumed.add(id);
}

function isConsumed(courseId: string, consumed: Set<string>): boolean {
    return equivalentCourseIds(courseId).some((id) => consumed.has(id));
}

function takeCourse(course: MatchableCourse, slot: RequirementSlot, state: MatchState): void {
    lockExclusive(course.courseId, state);
    if (!slot.allowReuse) {
        markConsumed(course.courseId, state.consumed);
    }
}

function candidateCourses(slot: RequirementSlot, state: MatchState): MatchableCourse[] {
    return state.all.filter((course) => {
        if (isBlockedByExclusive(course.courseId, state)) return false;
        if (!slot.allowReuse && isConsumed(course.courseId, state.consumed)) return false;
        if (slot.options.length > 0) {
            return slot.options.some((option) => optionMatchesCourse(option, course.courseId));
        }
        return matchesSelectionRule(slot, course.courseId);
    });
}

function fillSlot(slot: RequirementSlot, state: MatchState): {
    matched: MatchableCourse[];
    filledCourses: number;
    filledUnits: number;
} {
    if (slot.kind === 'milestone') {
        return { matched: [], filledCourses: 0, filledUnits: 0 };
    }

    const matched: MatchableCourse[] = [];
    let filledCourses = 0;
    let filledUnits = 0;

    const preferCompleted = [...candidateCourses(slot, state)].sort((a, b) => {
        if (a.source !== b.source) return a.source === 'completed' ? -1 : 1;
        return 0;
    });

    for (const course of preferCompleted) {
        if (slotIsMet(slot, filledCourses, filledUnits)) break;
        if (matched.some((entry) => idsOverlap(entry.courseId, course.courseId))) continue;
        if (!slot.allowReuse && isConsumed(course.courseId, state.consumed)) continue;
        const option = slot.options.find((entry) => optionMatchesCourse(entry, course.courseId));
        const units = optionUnits(option || { courseId: course.courseId }, course.units);
        matched.push(course);
        filledCourses += 1;
        filledUnits += units;
        takeCourse(course, slot, state);
    }

    return { matched, filledCourses, filledUnits };
}

function statusFor(slot: RequirementSlot, filledCourses: number, filledUnits: number, matched: MatchableCourse[]): SlotStatus {
    if (slot.kind === 'milestone') return 'remaining';
    const met = slotIsMet(slot, filledCourses, filledUnits);
    const usedIp = matched.some((course) => course.source === 'in_progress');
    if (met && usedIp) return 'in_progress';
    if (met) return 'satisfied';
    if (filledCourses > 0 || filledUnits > 0) return 'partial';
    return 'remaining';
}

function toSlotGap(
    slot: RequirementSlot,
    group: RequirementGroup,
    fill: { matched: MatchableCourse[]; filledCourses: number; filledUnits: number },
    chosen: boolean,
): SlotGap {
    const remain = remainingFor(slot, fill.filledCourses, fill.filledUnits);
    const matchedIds = fill.matched.map((course) => course.courseId);
    const remainingOptions = slot.options
        .map((option) => normalizeCourseCode(option.courseId) || option.courseId)
        .filter((courseId) => !matchedIds.some((matched) => idsOverlap(matched, courseId)));

    return {
        slotId: slot.id,
        groupId: group.id,
        groupName: group.name,
        name: slot.name,
        kind: slot.kind,
        status: statusFor(slot, fill.filledCourses, fill.filledUnits, fill.matched),
        requiredCourses: requiredCourses(slot),
        requiredUnits: requiredUnits(slot),
        filledCourses: fill.filledCourses,
        filledUnits: fill.filledUnits,
        remainingCourses: remain.courses,
        remainingUnits: remain.units,
        matchedCourseIds: matchedIds,
        remainingOptions,
        courseSetLabel: slot.courseSetLabel,
        notes: slot.notes,
        chosen,
    };
}

function completenessScore(slot: RequirementSlot, fill: { filledCourses: number; filledUnits: number; matched: MatchableCourse[] }): number {
    const status = statusFor(slot, fill.filledCourses, fill.filledUnits, fill.matched);
    if (status === 'satisfied') return 300;
    if (status === 'in_progress') return 200;
    const courseRatio = requiredCourses(slot) > 0 ? fill.filledCourses / requiredCourses(slot) : 0;
    const unitRatio = requiredUnits(slot) > 0 ? fill.filledUnits / requiredUnits(slot) : 0;
    return Math.round(100 * Math.max(courseRatio, unitRatio));
}

function cloneState(state: MatchState): MatchState {
    return {
        all: state.all,
        consumed: new Set(state.consumed),
        exclusiveLocked: new Map(state.exclusiveLocked),
        exclusiveSets: state.exclusiveSets,
    };
}

function evaluateGroup(group: RequirementGroup, state: MatchState): SlotGap[] {
    if (group.logic === 'choose') {
        const chooseCount = group.chooseCount ?? 1;
        const scored = group.slots.map((slot) => {
            const hypothetical = fillSlot(slot, cloneState(state));
            return { slot, hypothetical, score: completenessScore(slot, hypothetical) };
        });
        scored.sort((a, b) => b.score - a.score);
        const winners = new Set(scored.slice(0, chooseCount).map((entry) => entry.slot.id));

        return group.slots.map((slot) => {
            const chosen = winners.has(slot.id);
            const fill = chosen ? fillSlot(slot, state) : { matched: [], filledCourses: 0, filledUnits: 0 };
            return toSlotGap(slot, group, fill, chosen);
        });
    }

    return group.slots.map((slot) => toSlotGap(slot, group, fillSlot(slot, state), true));
}

export function transcriptToMatchable(rows: TranscriptCourseRow[]): MatchableCourse[] {
    const passing = transcriptCoursesToCompleted(rows);
    const withIp = transcriptCoursesToCompleted(rows, { includeInProgress: true });
    const inProgress = withIp.filter((course) => isInProgressGrade(course.grade));

    const byId = new Map<string, MatchableCourse>();
    for (const course of passing) {
        if (!isPassingGrade(course.grade)) continue;
        byId.set(course.courseId, {
            courseId: course.courseId,
            units: course.units || 0,
            source: 'completed',
            originalCode: course.courseId,
        });
    }
    for (const course of inProgress) {
        if (byId.has(course.courseId)) continue;
        byId.set(course.courseId, {
            courseId: course.courseId,
            units: course.units || 0,
            source: 'in_progress',
            originalCode: course.courseId,
        });
    }
    return Array.from(byId.values());
}

export function analyzeRequirementGaps(
    major: MajorRequirements,
    transcript: TranscriptCourseRow[],
): GapAnalysisResult {
    const matchable = transcriptToMatchable(transcript);
    const state: MatchState = {
        all: matchable,
        consumed: new Set(),
        exclusiveLocked: new Map(),
        exclusiveSets: major.exclusiveSets || [],
    };

    const slots: SlotGap[] = [];
    for (const group of major.groups) {
        slots.push(...evaluateGroup(group, state));
    }

    const remainingSlots = slots.filter((slot) => {
        if (slot.kind === 'milestone') return true;
        if (slot.chosen === false) return false;
        return slot.status === 'remaining' || slot.status === 'partial' || slot.status === 'in_progress';
    });

    const used = new Set(slots.flatMap((slot) => slot.matchedCourseIds));
    const unusedTranscriptCourses = matchable
        .map((course) => course.courseId)
        .filter((courseId) => !used.has(courseId));

    const unitsEarned = matchable
        .filter((course) => course.source === 'completed')
        .reduce((sum, course) => sum + course.units, 0);
    const unitsInProgress = matchable
        .filter((course) => course.source === 'in_progress')
        .reduce((sum, course) => sum + course.units, 0);

    return {
        majorId: major.id,
        majorName: major.name,
        majorCode: major.code,
        totalUnitsRequired: major.totalUnits,
        unitsEarned,
        unitsInProgress,
        slots,
        remainingSlots,
        unusedTranscriptCourses,
    };
}

export function remainingCandidateCourses(result: GapAnalysisResult): string[] {
    const ids = new Set<string>();
    for (const slot of result.remainingSlots) {
        for (const option of slot.remainingOptions) ids.add(option);
    }
    return Array.from(ids);
}
