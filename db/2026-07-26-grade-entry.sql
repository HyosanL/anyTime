-- =====================================================================
--  증분 마이그레이션 (2026-07-26): 학점계산기 저장 테이블 grade_entry
--
--  순수 additive — 기존 테이블/데이터에 손대지 않는다(cadet·users 무영향).
--  라이브에는 db/schema.sql 전체를 재실행하지 말고 이 파일만 적용한다.
--    supabase db query --linked --file db/2026-07-26-grade-entry.sql
--  재실행 안전(IF NOT EXISTS / DROP POLICY IF EXISTS).
-- =====================================================================

CREATE TABLE IF NOT EXISTS grade_entry (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cadet_id    UUID     NOT NULL REFERENCES cadet(id) ON DELETE CASCADE,
    year        SMALLINT NOT NULL,
    term        SMALLINT NOT NULL,
    course_name TEXT     NOT NULL CHECK (btrim(course_name) <> '' AND char_length(course_name) <= 60),
    credit      NUMERIC(3,1) CHECK (credit IS NULL OR (credit >= 0 AND credit <= 30)),
    grade       TEXT CHECK (grade IS NULL OR grade IN
                  ('A+','A0','A-','B+','B0','B-','C+','C0','C-','D+','D0','D-','F')),
    sort_order  INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grade_entry_cadet ON grade_entry (cadet_id, year DESC, term DESC, sort_order);

ALTER TABLE grade_entry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS own_grade_entry ON grade_entry;
CREATE POLICY own_grade_entry ON grade_entry FOR ALL TO authenticated
    USING (cadet_id = auth.uid()) WITH CHECK (cadet_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON grade_entry TO authenticated;
