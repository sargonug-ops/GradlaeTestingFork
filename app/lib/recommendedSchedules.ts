import { supabaseAdmin } from '@/app/lib/supabaseServer';
import { MAX_SAVED_PLANNERS } from '@/app/lib/recommenderConfig';
import type { ScheduleAnnotations } from '@/app/lib/scheduleAnnotations';
import type { ScheduleRecommendation } from '@/app/lib/scheduleRecommender';

export interface RecommendationGapSummary {
    remainingSlotCount: number;
    remainingUnits: number;
    unitsEarned: number;
    unitsInProgress: number;
    totalUnitsRequired: number;
}

export interface RecommendationPayload {
    majorId: string;
    majorName: string;
    majorCode: string;
    targetUnits: number;
    careerGoal: string | null;
    schedule: ScheduleRecommendation;
    annotations: ScheduleAnnotations | null;
    gapSummary: RecommendationGapSummary;
    createdAt: string;
}

export interface SavedRecommendation {
    id: string;
    majorId: string;
    createdAt: string;
    payload: RecommendationPayload;
}

/** After inserting `insertedId` at the front of a newest-first id list, ids past `max` should be deleted. */
export function overflowIdsNewestFirst(
    idsNewestFirst: string[],
    max: number = MAX_SAVED_PLANNERS,
): string[] {
    if (max < 1) return [...idsNewestFirst];
    return idsNewestFirst.slice(max);
}

export function mapRecommendationRow(row: {
    id: string;
    major_id: string;
    created_at: string;
    payload: RecommendationPayload;
}): SavedRecommendation {
    return {
        id: row.id,
        majorId: row.major_id,
        createdAt: row.created_at,
        payload: row.payload,
    };
}

export async function listSavedRecommendations(userId: string): Promise<SavedRecommendation[]> {
    const { data, error } = await supabaseAdmin
        .from('recommended_schedules')
        .select('id, major_id, created_at, payload')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

    if (error) {
        throw new Error(error.message);
    }

    return (data ?? []).map(mapRecommendationRow);
}

export async function saveRecommendation(
    userId: string,
    payload: RecommendationPayload,
): Promise<SavedRecommendation> {
    const { data, error } = await supabaseAdmin
        .from('recommended_schedules')
        .insert({
            user_id: userId,
            major_id: payload.majorId,
            payload,
        })
        .select('id, major_id, created_at, payload')
        .single();

    if (error || !data) {
        throw new Error(error?.message || 'Failed to save recommendation');
    }

    const { data: rows, error: listError } = await supabaseAdmin
        .from('recommended_schedules')
        .select('id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

    if (listError) {
        throw new Error(listError.message);
    }

    const overflow = overflowIdsNewestFirst((rows ?? []).map((row) => row.id as string));
    if (overflow.length > 0) {
        const { error: deleteError } = await supabaseAdmin
            .from('recommended_schedules')
            .delete()
            .eq('user_id', userId)
            .in('id', overflow);
        if (deleteError) {
            throw new Error(deleteError.message);
        }
    }

    return mapRecommendationRow(data);
}
