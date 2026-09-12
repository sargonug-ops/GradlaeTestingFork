export type Season = 'Fall' | 'Spring' | 'Summer' | 'Winter';

export interface AcademicTerm {
    season: 'Fall' | 'Spring';
    year: number;
}

export function parseTermLabel(term: string): { season: Season; year: number } | null {
    const match = term.match(/(Fall|Spring|Summer|Winter)\s+(20\d{2})/i);
    if (!match) return null;
    const season = (match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase()) as Season;
    return { season, year: parseInt(match[2], 10) };
}

export function termSortKey(term: AcademicTerm): number {
    return term.year * 2 + (term.season === 'Spring' ? 1 : 0);
}

export function formatTerm(term: AcademicTerm): string {
    return `${term.season} ${term.year}`;
}

/** Winter maps to Spring; Summer maps to the following Fall. */
export function toPlanningTerm(season: Season, year: number): AcademicTerm {
    if (season === 'Winter') return { season: 'Spring', year };
    if (season === 'Summer') return { season: 'Fall', year };
    return { season, year };
}

export function inferPlanningTerm(
    inProgressTerms: string[],
    now: Date = new Date(),
): AcademicTerm {
    const converted: AcademicTerm[] = [];
    for (const label of inProgressTerms) {
        const parsed = parseTermLabel(label);
        if (!parsed) continue;
        converted.push(toPlanningTerm(parsed.season, parsed.year));
    }
    if (converted.length > 0) {
        converted.sort((a, b) => termSortKey(b) - termSortKey(a));
        return converted[0];
    }
    return planningTermFromDate(now);
}

export function planningTermFromDate(now: Date): AcademicTerm {
    const month = now.getUTCMonth() + 1;
    const year = now.getUTCFullYear();
    if (month >= 1 && month <= 5) return { season: 'Spring', year };
    if (month >= 8 && month <= 12) return { season: 'Fall', year };
    return { season: 'Fall', year };
}

/** Fall YYYY → Fall YYYY + Spring YYYY+1. Spring YYYY → Spring only. */
export function termsInAcademicYear(start: AcademicTerm): AcademicTerm[] {
    if (start.season === 'Fall') {
        return [start, { season: 'Spring', year: start.year + 1 }];
    }
    return [start];
}

export function academicYearLabel(terms: AcademicTerm[]): string {
    const fall = terms.find((term) => term.season === 'Fall');
    if (fall) return `${fall.year}-${String(fall.year + 1).slice(2)}`;
    const spring = terms[0];
    return `${spring.year - 1}-${String(spring.year).slice(2)}`;
}
