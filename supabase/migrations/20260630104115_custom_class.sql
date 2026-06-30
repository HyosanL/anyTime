-- 직접 추가한 시간표 항목(DB에 없는 강의).
-- 계정 종속 데이터: timetable 과 동일하게 cadet(id) FK + 본인만 RLS.
CREATE TABLE IF NOT EXISTS custom_class (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cadet_id     UUID NOT NULL REFERENCES cadet(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    day_of_week  SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
    start_min    SMALLINT NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
    end_min      SMALLINT NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
    room         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT custom_class_time_order CHECK (end_min > start_min)
);

CREATE INDEX IF NOT EXISTS idx_custom_class_cadet ON custom_class (cadet_id);

ALTER TABLE custom_class ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS own_custom_class ON custom_class;
CREATE POLICY own_custom_class ON custom_class FOR ALL TO authenticated
    USING (cadet_id = auth.uid()) WITH CHECK (cadet_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON custom_class TO authenticated;
