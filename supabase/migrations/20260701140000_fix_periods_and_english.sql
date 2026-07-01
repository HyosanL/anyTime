-- =====================================================================
--  라이브 데이터 보정 (증분) — 26-1학기
--  1) 교시(period) 시간 정정: 과거 스키마의 플레이스홀더 시간이 남아
--     1교시 종료가 09:50 로 저장 → 1교시 강의가 시간표에서 1~2교시를 차지하던 문제.
--     편람(생도 일과시간표) 기준 8교시로 덮어쓰고, 유령 9교시 제거.
--  2) 영어회화1(C0015)·영어회화3(C0047) 원어민 수업 구조 정정:
--     Dan/Timothy/Justin 3인이 각 타임에 동시(수준별 3개 강의실) 진행.
--     기존 4분반(타임당 1인)을 4타임 × 3인 = 12분반으로 재구성.
--     ※ 두 과목 모두 확정시간표 등록(timetable) 0건이라 재구성 안전.
--  실행: supabase db push (linked). schema.sql 전체 재실행 금지.
-- =====================================================================
BEGIN;

-- 1) 교시 시간 정정 -----------------------------------------------------
INSERT INTO period(no,start_time,end_time) VALUES
  (1,'08:10','09:00'),(2,'09:10','10:00'),(3,'10:10','11:00'),(4,'11:10','12:00'),
  (5,'13:00','13:50'),(6,'14:00','14:50'),(7,'15:10','16:00'),(8,'16:10','17:00')
  ON CONFLICT (no) DO UPDATE SET start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time;
DELETE FROM period WHERE no > 8;  -- 편람은 8교시까지 (9교시 유령행 제거, 참조 없음 확인됨)

-- 2) 영어회화 원어민 수업 재구성 --------------------------------------
--   section_time → section 순서로 삭제(자식 먼저). 등록 0건이라 CASCADE 영향 없음.
DELETE FROM section_time WHERE course_code IN ('C0015','C0047') AND year=2026 AND term=1;
DELETE FROM section      WHERE course_code IN ('C0015','C0047') AND year=2026 AND term=1;

-- 분반: 타임 순(Dan/Timothy/Justin 반복)
INSERT INTO section(course_code,year,term,section_no,professor_code) VALUES
  -- 영어회화1 (수2/수3/목3/목4)
  ('C0015',2026,1,1 ,(SELECT code FROM professor WHERE name='Dan Kingyens'   LIMIT 1)),
  ('C0015',2026,1,2 ,(SELECT code FROM professor WHERE name='Timothy Swan'   LIMIT 1)),
  ('C0015',2026,1,3 ,(SELECT code FROM professor WHERE name='Justin Bunting' LIMIT 1)),
  ('C0015',2026,1,4 ,(SELECT code FROM professor WHERE name='Dan Kingyens'   LIMIT 1)),
  ('C0015',2026,1,5 ,(SELECT code FROM professor WHERE name='Timothy Swan'   LIMIT 1)),
  ('C0015',2026,1,6 ,(SELECT code FROM professor WHERE name='Justin Bunting' LIMIT 1)),
  ('C0015',2026,1,7 ,(SELECT code FROM professor WHERE name='Dan Kingyens'   LIMIT 1)),
  ('C0015',2026,1,8 ,(SELECT code FROM professor WHERE name='Timothy Swan'   LIMIT 1)),
  ('C0015',2026,1,9 ,(SELECT code FROM professor WHERE name='Justin Bunting' LIMIT 1)),
  ('C0015',2026,1,10,(SELECT code FROM professor WHERE name='Dan Kingyens'   LIMIT 1)),
  ('C0015',2026,1,11,(SELECT code FROM professor WHERE name='Timothy Swan'   LIMIT 1)),
  ('C0015',2026,1,12,(SELECT code FROM professor WHERE name='Justin Bunting' LIMIT 1)),
  -- 영어회화3 (금1/화1/화2/목1)
  ('C0047',2026,1,1 ,(SELECT code FROM professor WHERE name='Dan Kingyens'   LIMIT 1)),
  ('C0047',2026,1,2 ,(SELECT code FROM professor WHERE name='Timothy Swan'   LIMIT 1)),
  ('C0047',2026,1,3 ,(SELECT code FROM professor WHERE name='Justin Bunting' LIMIT 1)),
  ('C0047',2026,1,4 ,(SELECT code FROM professor WHERE name='Dan Kingyens'   LIMIT 1)),
  ('C0047',2026,1,5 ,(SELECT code FROM professor WHERE name='Timothy Swan'   LIMIT 1)),
  ('C0047',2026,1,6 ,(SELECT code FROM professor WHERE name='Justin Bunting' LIMIT 1)),
  ('C0047',2026,1,7 ,(SELECT code FROM professor WHERE name='Dan Kingyens'   LIMIT 1)),
  ('C0047',2026,1,8 ,(SELECT code FROM professor WHERE name='Timothy Swan'   LIMIT 1)),
  ('C0047',2026,1,9 ,(SELECT code FROM professor WHERE name='Justin Bunting' LIMIT 1)),
  ('C0047',2026,1,10,(SELECT code FROM professor WHERE name='Dan Kingyens'   LIMIT 1)),
  ('C0047',2026,1,11,(SELECT code FROM professor WHERE name='Timothy Swan'   LIMIT 1)),
  ('C0047',2026,1,12,(SELECT code FROM professor WHERE name='Justin Bunting' LIMIT 1));

-- 강의시간: Dan=457B, Timothy=457A, Justin=463 (요일 1월2화3수4목5금)
INSERT INTO section_time(course_code,year,term,section_no,day_of_week,start_period,end_period,room) VALUES
  -- 영어회화1: 수2 / 수3 / 목3 / 목4
  ('C0015',2026,1,1 ,3,2,2,'457B'),('C0015',2026,1,2 ,3,2,2,'457A'),('C0015',2026,1,3 ,3,2,2,'463'),
  ('C0015',2026,1,4 ,3,3,3,'457B'),('C0015',2026,1,5 ,3,3,3,'457A'),('C0015',2026,1,6 ,3,3,3,'463'),
  ('C0015',2026,1,7 ,4,3,3,'457B'),('C0015',2026,1,8 ,4,3,3,'457A'),('C0015',2026,1,9 ,4,3,3,'463'),
  ('C0015',2026,1,10,4,4,4,'457B'),('C0015',2026,1,11,4,4,4,'457A'),('C0015',2026,1,12,4,4,4,'463'),
  -- 영어회화3: 금1 / 화1 / 화2 / 목1
  ('C0047',2026,1,1 ,5,1,1,'457B'),('C0047',2026,1,2 ,5,1,1,'457A'),('C0047',2026,1,3 ,5,1,1,'463'),
  ('C0047',2026,1,4 ,2,1,1,'457B'),('C0047',2026,1,5 ,2,1,1,'457A'),('C0047',2026,1,6 ,2,1,1,'463'),
  ('C0047',2026,1,7 ,2,2,2,'457B'),('C0047',2026,1,8 ,2,2,2,'457A'),('C0047',2026,1,9 ,2,2,2,'463'),
  ('C0047',2026,1,10,4,1,1,'457B'),('C0047',2026,1,11,4,1,1,'457A'),('C0047',2026,1,12,4,1,1,'463');

COMMIT;

NOTIFY pgrst, 'reload schema';
