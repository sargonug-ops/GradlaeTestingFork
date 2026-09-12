import fs from 'fs';
import path from 'path';
import type { MajorRequirements } from '@/app/lib/majorRequirementsTypes';

export type {
    ExclusiveSet,
    GroupLogic,
    MajorCourseOption,
    MajorRequirements,
    RequirementGroup,
    RequirementKind,
    RequirementSlot,
    SelectionRule,
    SlotStatus,
} from '@/app/lib/majorRequirementsTypes';

const MAJORS_DIR = path.join(process.cwd(), 'data', 'majors');

let cachedMajors: MajorRequirements[] | null = null;

export function loadAllMajors(): MajorRequirements[] {
    if (cachedMajors) return cachedMajors;
    if (!fs.existsSync(MAJORS_DIR)) {
        cachedMajors = [];
        return cachedMajors;
    }

    const files = fs.readdirSync(MAJORS_DIR).filter((file) => file.endsWith('.json'));
    cachedMajors = files.map((file) => {
        const raw = fs.readFileSync(path.join(MAJORS_DIR, file), 'utf-8');
        return JSON.parse(raw) as MajorRequirements;
    });
    return cachedMajors;
}

export function loadMajorById(id: string): MajorRequirements | null {
    return loadAllMajors().find((major) => major.id === id) || null;
}

export function listMajorSummaries(): Array<{ id: string; code: string; name: string; totalUnits: number }> {
    return loadAllMajors().map((major) => ({
        id: major.id,
        code: major.code,
        name: major.name,
        totalUnits: major.totalUnits,
    }));
}

export function resetMajorCache(): void {
    cachedMajors = null;
}
