-- =====================================================================
--  정보 수정 제안 (correction) — 사용자가 잘못된 교수/과목/분반·시간·강의실을
--  신고하면 관리자가 검토 후 반영. 완전 익명(작성자 미저장).
--  라이브: 이 증분만 실행(db push). schema.sql 전체 재실행 금지.
-- =====================================================================
CREATE TABLE IF NOT EXISTS correction (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    target      TEXT NOT NULL CHECK (target IN ('professor','course','section','section_time')),
    target_key  JSONB NOT NULL,   -- {code} | {course_code,year,term,section_no}
    label       TEXT,             -- 사람이 읽는 대상(예: "전쟁사 3분반")
    field       TEXT NOT NULL CHECK (field IN ('name','department','credits','professor','room','time')),
    suggested   TEXT,             -- 제안값(시간은 "수3 수4 금1" 형식)
    note        TEXT,             -- 설명
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_correction_status ON correction (status, created_at DESC);

-- RLS: 정책 없음 → 직접 접근 불가. 제출은 아래 RPC(SECURITY DEFINER), 조회/처리는 admin-action(service_role).
ALTER TABLE correction ENABLE ROW LEVEL SECURITY;

-- 제출(익명): 로그인만 확인하고 작성자는 저장하지 않음.
CREATE OR REPLACE FUNCTION submit_correction(
    p_target TEXT, p_target_key JSONB, p_label TEXT,
    p_field TEXT, p_suggested TEXT, p_note TEXT
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id BIGINT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다.'; END IF;
    IF p_target NOT IN ('professor','course','section','section_time') THEN RAISE EXCEPTION '대상 오류'; END IF;
    IF p_field NOT IN ('name','department','credits','professor','room','time') THEN RAISE EXCEPTION '항목 오류'; END IF;
    INSERT INTO correction(target, target_key, label, field, suggested, note)
    VALUES (p_target, p_target_key, NULLIF(p_label,''), p_field, NULLIF(p_suggested,''), NULLIF(p_note,''))
    RETURNING id INTO v_id;
    RETURN v_id;
END; $$;
GRANT EXECUTE ON FUNCTION submit_correction(TEXT,JSONB,TEXT,TEXT,TEXT,TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
