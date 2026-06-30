-- custom_class: 학기 분리(year, term) + 겹침 검사 트리거

-- 1) 학기 컬럼
ALTER TABLE custom_class ADD COLUMN IF NOT EXISTS year SMALLINT;
ALTER TABLE custom_class ADD COLUMN IF NOT EXISTS term SMALLINT;

-- 2) 기존 행 백필: 현재 학기(없으면 최신 학기)
UPDATE custom_class c
SET year = COALESCE(c.year, s.year), term = COALESCE(c.term, s.term)
FROM (SELECT year, term FROM semester ORDER BY is_current DESC, year DESC, term DESC LIMIT 1) s
WHERE c.year IS NULL OR c.term IS NULL;

-- 학기 정보 자체가 없으면(백필 불가) 고아 행 제거
DELETE FROM custom_class WHERE year IS NULL OR term IS NULL;

ALTER TABLE custom_class ALTER COLUMN year SET NOT NULL;
ALTER TABLE custom_class ALTER COLUMN term SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_custom_class_sem ON custom_class (cadet_id, year, term);

-- 3) 겹침 검사: 같은 생도·학기·요일에서 분(min) 구간이 겹치면 거부.
--    직접추가 vs 직접추가 + 직접추가 vs 등록(확정시간표) 모두 검사.
CREATE OR REPLACE FUNCTION custom_class_no_overlap() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM custom_class c
    WHERE c.cadet_id = NEW.cadet_id AND c.year = NEW.year AND c.term = NEW.term
      AND c.day_of_week = NEW.day_of_week AND c.id <> NEW.id
      AND NEW.start_min < c.end_min AND c.start_min < NEW.end_min
  ) THEN
    RAISE EXCEPTION 'custom_class overlap: 다른 직접추가 강의와 시간이 겹칩니다'
      USING ERRCODE = '23P01';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM timetable t
    JOIN section_time st
      ON st.course_code = t.course_code AND st.year = t.year
     AND st.term = t.term AND st.section_no = t.section_no
    JOIN period ps ON ps.no = st.start_period
    JOIN period pe ON pe.no = st.end_period
    WHERE t.cadet_id = NEW.cadet_id AND t.year = NEW.year AND t.term = NEW.term
      AND st.day_of_week = NEW.day_of_week
      AND NEW.start_min < (EXTRACT(HOUR FROM pe.end_time)::int * 60 + EXTRACT(MINUTE FROM pe.end_time)::int)
      AND (EXTRACT(HOUR FROM ps.start_time)::int * 60 + EXTRACT(MINUTE FROM ps.start_time)::int) < NEW.end_min
  ) THEN
    RAISE EXCEPTION 'custom_class overlap: 등록한 강의와 시간이 겹칩니다'
      USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_custom_class_no_overlap ON custom_class;
CREATE TRIGGER trg_custom_class_no_overlap
  BEFORE INSERT OR UPDATE ON custom_class
  FOR EACH ROW EXECUTE FUNCTION custom_class_no_overlap();
