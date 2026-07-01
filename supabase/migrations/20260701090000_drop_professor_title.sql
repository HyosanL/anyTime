-- 교수 계급(title) 컬럼 제거. 앱 어디에서도 사용하지 않음(관리가 어려워 폐기).
-- professor 를 참조하는 뷰(professor_rating 등)는 title 을 쓰지 않아 DROP 이 막히지 않음.
ALTER TABLE professor DROP COLUMN IF EXISTS title;
