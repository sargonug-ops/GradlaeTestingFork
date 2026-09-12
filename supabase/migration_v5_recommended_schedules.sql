-- =============================================================================
-- PACEMAKER – Supabase Schema Migration v5 (Recommended schedules)
-- =============================================================================
-- Run in Supabase SQL Editor after migration.sql + migration_v2/v3/v4.
-- Stores class-recommender output separately from planners.planner_json so
-- /api/planner and /api/degree-audit keep using the student's manual template.
-- API routes use the service role (bypasses RLS). Cap of 5 rows per user is
-- enforced in application code (oldest deleted after insert).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.recommended_schedules (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    major_id    TEXT NOT NULL,
    payload     JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recommended_schedules_user_created_idx
    ON public.recommended_schedules (user_id, created_at DESC);

ALTER TABLE public.recommended_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own recommended schedules"
    ON public.recommended_schedules FOR SELECT
    USING (user_id IN (SELECT id FROM public.users WHERE auth_id = auth.uid()));

CREATE POLICY "Users can insert own recommended schedules"
    ON public.recommended_schedules FOR INSERT
    WITH CHECK (user_id IN (SELECT id FROM public.users WHERE auth_id = auth.uid()));

CREATE POLICY "Users can delete own recommended schedules"
    ON public.recommended_schedules FOR DELETE
    USING (user_id IN (SELECT id FROM public.users WHERE auth_id = auth.uid()));

COMMENT ON TABLE public.recommended_schedules IS
    'Saved class-recommender plans. Max 5 per user enforced by /api/recommend.';
COMMENT ON COLUMN public.recommended_schedules.payload IS
    'JSON: majorId, majorName, schedule, annotations, gapSummary, careerGoal, createdAt';
