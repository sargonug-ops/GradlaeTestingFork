import { NextRequest, NextResponse } from 'next/server';
import { listMajorSummaries, loadMajorById } from '@/app/lib/majorRequirements';
import { buildRecommendation } from '@/app/lib/recommendPipeline';
import {
    listSavedRecommendations,
    saveRecommendation,
    type RecommendationPayload,
} from '@/app/lib/recommendedSchedules';
import { getUserFromRequest } from '@/app/lib/supabaseAuth';
import { supabaseAdmin } from '@/app/lib/supabaseServer';
import { toTranscriptCourseRows, type TranscriptCourseRow } from '@/app/lib/transcriptUtils';
import { recommendRequestSchema, validateBody } from '@/app/lib/validation';

export const runtime = 'nodejs';
export const maxDuration = 60;

async function loadLatestTranscriptCourses(userId: string): Promise<TranscriptCourseRow[]> {
    const { data } = await supabaseAdmin
        .from('transcripts')
        .select('parsed_json')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

    const parsed = data?.parsed_json as { courses?: unknown } | null | undefined;
    return toTranscriptCourseRows(parsed?.courses);
}

export async function GET(request: NextRequest) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const recommendations = await listSavedRecommendations(user.id);
        return NextResponse.json({
            majors: listMajorSummaries(),
            recommendations,
        });
    } catch (error) {
        console.error('Recommend GET error:', error);
        return NextResponse.json({ error: 'Failed to load recommendations' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const validation = validateBody(recommendRequestSchema, await request.json());
        if (!validation.success) {
            return NextResponse.json({ error: validation.error }, { status: 400 });
        }

        const { majorId, targetUnits, careerGoal, transcript, save, now } = validation.data;
        const major = loadMajorById(majorId);
        if (!major) {
            return NextResponse.json({ error: `Unknown majorId: ${majorId}` }, { status: 400 });
        }

        const rows = transcript !== undefined
            ? toTranscriptCourseRows(transcript)
            : await loadLatestTranscriptCourses(user.id);

        if (rows.length === 0) {
            return NextResponse.json(
                { error: 'Transcript required. Upload a transcript or send transcript courses in the request body.' },
                { status: 400 },
            );
        }

        const built = await buildRecommendation({
            major,
            transcript: rows,
            targetUnits,
            careerGoal,
            now: now ? new Date(now) : undefined,
        });

        const createdAt = new Date().toISOString();
        const payload: RecommendationPayload = {
            majorId: major.id,
            majorName: major.name,
            majorCode: major.code,
            targetUnits: built.schedule.targetUnits,
            careerGoal: careerGoal ? careerGoal.trim() : null,
            schedule: built.schedule,
            annotations: built.annotations,
            gapSummary: built.gapSummary,
            createdAt,
        };

        const shouldSave = save !== false;
        const saved = shouldSave ? await saveRecommendation(user.id, payload) : null;

        return NextResponse.json({
            id: saved?.id ?? null,
            saved: Boolean(saved),
            majorId: major.id,
            majorName: major.name,
            majorCode: major.code,
            gapSummary: built.gapSummary,
            schedule: built.schedule,
            annotations: built.annotations,
            createdAt: saved?.createdAt ?? createdAt,
        });
    } catch (error) {
        console.error('Recommend POST error:', error);
        return NextResponse.json({ error: 'Failed to generate recommendation' }, { status: 500 });
    }
}
