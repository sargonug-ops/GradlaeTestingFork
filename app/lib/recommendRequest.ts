import { loadMajorById, type MajorRequirements } from '@/app/lib/majorRequirements';
import { toTranscriptCourseRows, type TranscriptCourseRow } from '@/app/lib/transcriptUtils';
import type { recommendRequestSchema } from '@/app/lib/validation';
import type { z } from 'zod';

export type RecommendRequestBody = z.infer<typeof recommendRequestSchema>;

export type ResolveRecommendResult =
    | { ok: true; major: MajorRequirements; transcript: TranscriptCourseRow[] }
    | { ok: false; error: string };

export function resolveRecommendInputs(
    body: RecommendRequestBody,
    storedCourses: unknown,
    loadMajor: typeof loadMajorById = loadMajorById,
): ResolveRecommendResult {
    const major = loadMajor(body.majorId);
    if (!major) {
        return { ok: false, error: `Unknown majorId: ${body.majorId}` };
    }

    const transcript = body.transcript !== undefined
        ? toTranscriptCourseRows(body.transcript)
        : toTranscriptCourseRows(storedCourses);

    if (transcript.length === 0) {
        return {
            ok: false,
            error: 'Transcript required. Upload a transcript or send transcript courses in the request body.',
        };
    }

    return { ok: true, major, transcript };
}
