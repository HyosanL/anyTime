-- =====================================================================
--  모더레이션 "모두 확인 처리" 컷오프 (증분)
--  app_setting.mod_reviewed_at 이후 생성된 글만 대시보드에 노출.
--  관리자가 '모두 확인 처리'를 누르면 이 값을 now() 로 갱신 → 그 이전 글은
--  대시보드에서 사라짐(데이터는 그대로, 표시만 숨김). per-post 상태 없이
--  타임스탬프 1개로 큐를 비우는 방식 — 완전 익명 원칙과 정합.
--  실행: supabase db push (linked). schema.sql 전체 재실행 금지.
-- =====================================================================
BEGIN;

ALTER TABLE app_setting ADD COLUMN IF NOT EXISTS mod_reviewed_at TIMESTAMPTZ;  -- 모더레이션 확인 컷오프(이전 글 숨김)

COMMIT;

NOTIFY pgrst, 'reload schema';
