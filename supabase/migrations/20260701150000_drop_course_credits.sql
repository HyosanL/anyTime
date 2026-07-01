-- =====================================================================
--  과목 학점(credits) 컬럼 제거. 앱 어디에서도 학점 정보를 쓰지 않음(폐기).
--  · course.credits 삭제 (section 등 참조 없음 → DROP 막히지 않음).
--  · 정보 수정 제안(correction)의 field 에서도 'credits' 제외.
--  라이브: 이 증분만 실행(db push). schema.sql 전체 재실행 금지.
-- =====================================================================
BEGIN;

-- 1) 과목 학점 컬럼 제거
ALTER TABLE course DROP COLUMN IF EXISTS credits;

-- 2) 수정 제안 field 목록에서 credits 제외 (기존 credits 제안이 있으면 함께 정리)
DELETE FROM correction WHERE field = 'credits';
ALTER TABLE correction DROP CONSTRAINT IF EXISTS correction_field_check;
ALTER TABLE correction ADD CONSTRAINT correction_field_check
  CHECK (field IN ('name','department','professor','room','time'));

-- 3) 제출 RPC 재정의: 허용 field 에서 credits 제거 (나머지는 기존과 동일)
CREATE OR REPLACE FUNCTION submit_correction(
    p_target TEXT, p_target_key JSONB, p_label TEXT,
    p_field TEXT, p_suggested TEXT, p_note TEXT
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id BIGINT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다.'; END IF;
    IF p_target NOT IN ('professor','course','section','section_time') THEN RAISE EXCEPTION '대상 오류'; END IF;
    IF p_field NOT IN ('name','department','professor','room','time') THEN RAISE EXCEPTION '항목 오류'; END IF;
    INSERT INTO correction(target, target_key, label, field, suggested, note)
    VALUES (p_target, p_target_key, NULLIF(p_label,''), p_field, NULLIF(p_suggested,''), NULLIF(p_note,''))
    RETURNING id INTO v_id;
    RETURN v_id;
END; $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
