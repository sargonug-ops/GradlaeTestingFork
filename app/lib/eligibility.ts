import type { CompletedCourse, PrerequisiteNode } from '@/types';
import { CourseGraph } from '@/app/lib/courseGraph';
import { normalizeCourseCode } from '@/app/lib/courseCodes';

export type PrereqStatus = 'met' | 'unmet' | 'unknown';

export interface EligibilityResult {
    eligible: boolean;
    prereqStatus: PrereqStatus;
    missing: string[];
}

export function graphFromPrerequisiteMap(prereqs: Record<string, PrerequisiteNode>): CourseGraph {
    const courses = Object.entries(prereqs).map(([id, prerequisites]) => ({
        id,
        courseId: 0,
        subjectCode: id.split('-')[0] || '',
        catalogNumber: id.split('-')[1] || '',
        title: id,
        description: '',
        units: { min: 3, max: 3 },
        prerequisites,
        components: [],
        attributes: [],
        offeringUnit: '',
        gradingBasis: '',
        repeatable: false,
    }));
    return new CourseGraph(courses);
}

export function evaluateEligibility(
    courseId: string,
    completed: CompletedCourse[],
    graph?: CourseGraph | null,
): EligibilityResult {
    const id = normalizeCourseCode(courseId) || courseId;
    if (!graph) {
        return { eligible: true, prereqStatus: 'unknown', missing: [] };
    }
    if (!graph.getCourse(id)) {
        return { eligible: true, prereqStatus: 'unknown', missing: [] };
    }
    const result = graph.canTakeCourse(id, completed);
    return {
        eligible: result.eligible,
        prereqStatus: result.eligible ? 'met' : 'unmet',
        missing: result.missing,
    };
}

function collectCoursePrereqs(node: PrerequisiteNode | undefined, into: Set<string>): void {
    if (!node) return;
    if (node.type === 'COURSE' && node.value) {
        const id = normalizeCourseCode(node.value) || node.value;
        into.add(id);
        return;
    }
    node.children?.forEach((child) => collectCoursePrereqs(child, into));
}

/** How many remaining PDF courses list `courseId` as a direct prerequisite. */
export function unlockCount(
    courseId: string,
    remainingCourseIds: string[],
    graph?: CourseGraph | null,
): number {
    if (!graph) return 0;
    const needle = normalizeCourseCode(courseId) || courseId;
    let count = 0;
    for (const other of remainingCourseIds) {
        if (other === needle) continue;
        const course = graph.getCourse(other);
        if (!course) continue;
        const prereqs = new Set<string>();
        collectCoursePrereqs(course.prerequisites, prereqs);
        if (prereqs.has(needle)) count += 1;
    }
    return count;
}
