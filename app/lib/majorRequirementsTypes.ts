export type RequirementKind = 'courses' | 'units' | 'course_set' | 'milestone';
export type GroupLogic = 'all' | 'choose';
export type SlotStatus = 'satisfied' | 'in_progress' | 'partial' | 'remaining';

export interface MajorCourseOption {
    courseId: string;
    title?: string;
    units?: number;
}

export interface SelectionRule {
    subject?: string;
    minLevel?: number;
}

export interface RequirementSlot {
    id: string;
    name: string;
    kind: RequirementKind;
    minCourses?: number;
    minUnits?: number;
    options: MajorCourseOption[];
    courseSetLabel?: string;
    notes?: string;
    minGrade?: string;
    allowReuse?: boolean;
    selectionRule?: SelectionRule;
}

export interface RequirementGroup {
    id: string;
    name: string;
    logic: GroupLogic;
    chooseCount?: number;
    slots: RequirementSlot[];
}

export interface ExclusiveSet {
    id: string;
    courseIds: string[];
}

export interface MajorRequirements {
    id: string;
    code: string;
    name: string;
    college?: string;
    catalogYear?: string;
    totalUnits: number;
    source?: string;
    exclusiveSets?: ExclusiveSet[];
    groups: RequirementGroup[];
}
