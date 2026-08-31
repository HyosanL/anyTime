-- =====================================================================
--  증분 마이그레이션 (2026-08-31): 학점계산기 — 학기별 등수 저장 테이블 rank_entry
--
--  학위교육과목 등수·생활/훈련과목 등수를 학기당 한 행에 저장한다(각각 내 등수/총원).
--  순수 additive — 기존 테이블/데이터에 손대지 않는다.
--  라이브에는 db/schema.sql 전체를 재실행하지 말고 이 파일만 적용한다.
--    supabase db query --linked --file db/2026-08-31-rank-entry.sql
--  재실행 안전(IF NOT EXISTS / DROP POLICY IF EXISTS).
-- =====================================================================

CREATE TABLE IF NOT EXISTS rank_entry (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cadet_id        UUID     NOT NULL REFERENCES cadet(id) ON DELETE CASCADE,
    year            SMALLINT NOT NULL,
    term            SMALLINT NOT NULL,
    academic_rank   INT CHECK (academic_rank  IS NULL OR academic_rank  >= 1),   -- 학위교육과목 내 등수
    academic_total  INT CHECK (academic_total IS NULL OR academic_total >= 1),   -- 학위교육과목 총원
    training_rank   INT CHECK (training_rank  IS NULL OR training_rank  >= 1),   -- 생활/훈련과목 내 등수
    training_total  INT CHECK (training_total IS NULL OR training_total >= 1),   -- 생활/훈련과목 총원
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (cadet_id, year, term),
    CHECK (academic_rank IS NULL OR academic_total IS NULL OR academic_rank <= academic_total),
    CHECK (training_rank IS NULL OR training_total IS NULL OR training_rank <= training_total)
);

CREATE INDEX IF NOT EXISTS idx_rank_entry_cadet ON rank_entry (cadet_id, year DESC, term DESC);

ALTER TABLE rank_entry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS own_rank_entry ON rank_entry;
CREATE POLICY own_rank_entry ON rank_entry FOR ALL TO authenticated
    USING (cadet_id = auth.uid()) WITH CHECK (cadet_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON rank_entry TO authenticated;
