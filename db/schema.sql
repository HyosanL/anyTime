-- =====================================================================
--  애타 (anyTime) — 생도 강의정보 공유 앱  ·  통합 스키마 (단일 원본)
--  이 파일 하나가 전체 DB 정의(테이블·RLS·RPC·뷰·pg_cron·인프라 시드)의 단일 원본이다.
--  설계: 데이터 요구사항 → 개체·관계 추출 → E-R 다이어그램 →
--  릴레이션 변환·정규화(3NF~BCNF) → 이 DDL.
--  라이브 변경은 증분 스크립트로만(아래 주의).
--
--  ▶ 신규 프로젝트 셋업 순서 (Supabase SQL Editor 에 순서대로 Run):
--      1) db/schema.sql   (이 파일 — 스키마+RLS+RPC+뷰+cron+인프라시드)
--      2) db/comments.sql (테이블·컬럼 한글 주석 — 관리자 대시보드 가독성)
--    실제 카탈로그(교수·과목·분반)는 시드 파일이 아니라 관리자 화면에서 관리한다
--    (앱 관리자 화면에서 CSV 일괄등록/편집).
--    (pg_cron/pg_net 생성이 막히면 Dashboard>Database>Extensions 에서 먼저 활성화)
--  ⚠️ 라이브(운영) DB 엔 이 파일을 통째로 재실행하지 말 것(cadet/auth 삭제됨).
--     운영 반영은 증분 ALTER 또는 db/comments.sql(데이터 무영향)만.
--
--  [명세서 ↔ 구현 매핑·보정 사항]
--   · 생도.아이디(PK)  → cadet.username(UNIQUE 자연키),  비밀번호 → Supabase Auth
--     식별 surrogate    → cadet.id = auth.uid()(UUID, 합성이메일 매핑)
--   · 확정시간표.아이디 → timetable.cadet_id (명세서 '아이디'). 명세서의 '확정시간표'는
--     timetable(is_primary = TRUE) 한 개 = 학기별 확정. 그 외 시간표는 초안(지난 학기
--     기록·다음 학기 미리짜기)이며 강의평·메모 자격에 영향을 주지 않는다(2026-07-12).
--   · 과락률·평점·뱃지  → 뷰/앱에서 산출(유도속성, 미저장)
--   · 누적작성수(post_count)는 작성자를 저장하지 않으므로(완전 익명) 재계산 불가 →
--     저장 유도속성으로 유지(명세서 ㉒ 비고). 좋아요수·신고수·댓글수·HOT·최근활동일시
--     등 운영 확장 기능의 카운트도 같은 이유(이벤트 1일 파기)로 저장한다.
--   · 익명게시판·웹푸시·신고 자동검열·금지어는 명세서(설계 문서) 범위 밖의
--     운영 확장 기능이다 — 본 파일에는 실제 구현 전체를 유지한다.
--     (사용자 차단 기능은 2026-07-06 완전 제거 — 테이블·가드·RPC·관리자 액션 없음)
--
--  [정규화(2026-07-06) — 변환규칙·정규형 반영]
--   · 다중값 속성 분해(1NF·규칙5): 족보 첨부(구 files JSONB + 대표파일 4컬럼) → exam_file,
--     게시글 이미지(구 image_key/image_keys 배열) → board_post_image.
--   · 복합 속성 분해(규칙1 비고): 수정제안 대상 키(구 target_key JSONB) →
--     professor_code/course_code/year/term/section_no 단순 속성 + FK 참조 무결성.
--   · 전 도메인 릴레이션이 BCNF 를 만족한다.
--
--  [시간표 다중화(2026-07-12)]
--   · 구 timetable(생도 N:M 분반, 평평한 집합) → timetable(시간표 개체) +
--     timetable_entry(담긴 분반, 약한 개체). 학기별 확정 1개(is_primary).
--   · timetable_entry 가 분반키 4컬럼을 그대로 들면 timetable_id → year,term 함수종속이
--     생겨 BCNF 가 깨진다 → section 에 대체키 id 를 두고 단일 컬럼(section_id)으로 참조.
--     학기 일치(분반 학기 = 시간표 학기)는 FK 대신 트리거로 강제한다.
-- =====================================================================

-- 0. 확장 / 공통 -------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DROP DOMAIN IF EXISTS score5 CASCADE;
CREATE DOMAIN score5 AS SMALLINT CHECK (VALUE BETWEEN 1 AND 5);   -- 1~5 척도

-- 재실행 안전(개발용. 운영 데이터 있으면 이 블록 제거)
DROP VIEW  IF EXISTS course_professor_rating, professor_rating CASCADE;
DROP TABLE IF EXISTS deleted_content, push_config, post_watch, push_subscription,
    board_favorite, board_event, board_comment, board_post_image, board_post, board,
    correction, memo_report, review_report, class_memo, exam_file, exam_archive, review,
    custom_class, timetable_entry, timetable, section_time, section, common_block, period,
    course, semester, professor, banned_word, notice, app_setting, cadet CASCADE;


-- =====================================================================
--  1장. 회원·인증
-- =====================================================================
-- 명세서의 '생도'와 '관리자'를 한 테이블로 통합(관리자는 생도이므로 is_admin 플래그).
CREATE TABLE cadet (
    id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    username    TEXT NOT NULL UNIQUE,                 -- 아이디
    post_count  INTEGER NOT NULL DEFAULT 0,           -- 누적작성수
    is_admin    BOOLEAN NOT NULL DEFAULT FALSE,       -- 관리자 여부
    tt_public   BOOLEAN NOT NULL DEFAULT FALSE,       -- 내 확정시간표 공개(시간표 공유 opt-in)
    geo_verified_at TIMESTAMPTZ,                       -- 마지막 지오펜싱 인증시각
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- =====================================================================
--  2장. 기준 정보 (교수·학기·과목·교시)
-- =====================================================================
CREATE TABLE professor (
    code        TEXT PRIMARY KEY,      -- 교수코드(자동 부여)
    name        TEXT NOT NULL,         -- 성명
    department  TEXT,                  -- 학과
    office      TEXT                   -- 연구실 위치(공사 홈페이지 교수소개 크롤, sync-professors)
);

CREATE TABLE semester (
    year        SMALLINT NOT NULL,                         -- 연도
    term        SMALLINT NOT NULL CHECK (term IN (1, 2)),  -- 학기구분
    is_current  BOOLEAN NOT NULL DEFAULT FALSE,            -- (구현보조) 현재학기
    PRIMARY KEY (year, term)
);

CREATE TABLE course (
    code        TEXT PRIMARY KEY,      -- 과목코드
    name        TEXT NOT NULL,         -- 과목명
    department  TEXT                   -- (구현) 개설학과
);

CREATE TABLE period (
    no          SMALLINT PRIMARY KEY,  -- 교시번호
    start_time  TIME NOT NULL,         -- 시작시각
    end_time    TIME NOT NULL,         -- 종료시각
    CHECK (end_time > start_time)
);

-- 전 생도 공통 비수업 시간(생도대시간·군사훈련·자율선택형교과 …).
-- 그 학기에 '어떤 분반도 열리지 않는' 요일×교시가 곧 이 시간이다 — 편람에 구멍으로 찍혀
-- 있으므로 시각(요일·교시)은 카탈로그에서 그대로 유도된다(앱이 클라이언트에서 계산).
-- 이 표는 그 구멍에 '이름'을 붙이기 위해 있다(관리자가 편람 일괄등록 때 붙인다).
-- 시간표 마법사는 이 시간을 '빈 시간(공강교시)'으로 세지 않는다 — 원래 수업이 없는 시간이므로.
CREATE TABLE common_block (
    year         SMALLINT NOT NULL,
    term         SMALLINT NOT NULL,
    day_of_week  SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),  -- 1=월..7=일
    start_period SMALLINT NOT NULL REFERENCES period(no),
    end_period   SMALLINT NOT NULL REFERENCES period(no),
    label        TEXT NOT NULL CHECK (btrim(label) <> '' AND char_length(label) <= 20),
    PRIMARY KEY (year, term, day_of_week, start_period),
    FOREIGN KEY (year, term) REFERENCES semester(year, term) ON DELETE CASCADE,
    CHECK (end_period >= start_period)
);


-- =====================================================================
--  3장. 분반·강의시간
-- =====================================================================
CREATE TABLE section (
    course_code     TEXT     NOT NULL REFERENCES course(code) ON DELETE CASCADE,
    year            SMALLINT NOT NULL,
    term            SMALLINT NOT NULL,
    section_no      SMALLINT NOT NULL,                          -- 분반번호
    professor_code  TEXT REFERENCES professor(code) ON DELETE SET NULL,
    -- 대체키: timetable_entry 가 분반을 단일 컬럼으로 참조하기 위한 surrogate.
    -- (분반키 4컬럼을 entry 에 복제하면 timetable_id → year,term 함수종속 → BCNF 위반)
    id              BIGINT GENERATED BY DEFAULT AS IDENTITY UNIQUE,
    PRIMARY KEY (course_code, year, term, section_no),
    FOREIGN KEY (year, term) REFERENCES semester(year, term) ON DELETE CASCADE
);

CREATE TABLE section_time (
    course_code  TEXT     NOT NULL,
    year         SMALLINT NOT NULL,
    term         SMALLINT NOT NULL,
    section_no   SMALLINT NOT NULL,
    day_of_week  SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),  -- 1=월..7=일
    start_period SMALLINT NOT NULL REFERENCES period(no),   -- 시작교시
    end_period   SMALLINT NOT NULL REFERENCES period(no),   -- 종료교시
    room         TEXT,                                      -- 강의실
    PRIMARY KEY (course_code, year, term, section_no, day_of_week, start_period),
    FOREIGN KEY (course_code, year, term, section_no)
        REFERENCES section(course_code, year, term, section_no) ON DELETE CASCADE,
    CHECK (end_period >= start_period)
);


-- =====================================================================
--  4장. 시간표 (생도 1:N 시간표, 시간표 N:M 분반)
--
--  한 생도가 학기마다 여러 시간표를 가진다(지난 학기 기록·다음 학기 미리짜기).
--  그중 학기별 1개가 확정(is_primary) — 명세서의 '확정시간표'. 홈에서 전환한다.
--  강의평·메모 자격은 확정 시간표만 인정한다(초안으로 메모를 열람하는 구멍 차단).
-- =====================================================================
CREATE TABLE timetable (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cadet_id    UUID     NOT NULL REFERENCES cadet(id) ON DELETE CASCADE,  -- 아이디
    year        SMALLINT NOT NULL,
    term        SMALLINT NOT NULL,
    name        TEXT     NOT NULL CHECK (char_length(name) <= 20),   -- 공란('') 허용, 길이만 제한
    is_primary  BOOLEAN  NOT NULL DEFAULT FALSE,                 -- 확정(학기별 1개)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (year, term) REFERENCES semester(year, term) ON DELETE CASCADE
);
CREATE INDEX idx_timetable_cadet ON timetable (cadet_id, year DESC, term DESC);
CREATE UNIQUE INDEX uq_timetable_primary ON timetable (cadet_id, year, term) WHERE is_primary;

-- 시간표에 담긴 분반(약한 개체). 분반은 대체키 section.id 로 참조한다(BCNF — 파일 머리말 참조).
CREATE TABLE timetable_entry (
    timetable_id BIGINT NOT NULL REFERENCES timetable(id) ON DELETE CASCADE,
    section_id   BIGINT NOT NULL REFERENCES section(id)   ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),   -- 강의평 자격(N일 보유) 기준
    PRIMARY KEY (timetable_id, section_id)
);
CREATE INDEX idx_tt_entry_section ON timetable_entry (section_id);

-- 직접 추가 시간표 항목(DB에 없는 강의). 시간표 종속·본인만(RLS).
CREATE TABLE custom_class (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    timetable_id BIGINT NOT NULL REFERENCES timetable(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    day_of_week  SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
    start_min    SMALLINT NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
    end_min      SMALLINT NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
    room         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT custom_class_time_order CHECK (end_min > start_min)
);
CREATE INDEX idx_custom_class_tt ON custom_class (timetable_id);

-- 시간표 가드: 학기당 5개 상한 · 그 학기 첫 시간표는 자동 확정 · 확정은 학기별 1개
CREATE OR REPLACE FUNCTION timetable_set_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_cnt INT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT count(*) INTO v_cnt FROM timetable
         WHERE cadet_id = NEW.cadet_id AND year = NEW.year AND term = NEW.term;
        IF v_cnt >= 5 THEN
            RAISE EXCEPTION '한 학기에 시간표는 5개까지 만들 수 있습니다.';
        END IF;
        IF v_cnt = 0 THEN NEW.is_primary := TRUE; END IF;
    END IF;
    IF NEW.is_primary THEN                                   -- 확정 지정 → 같은 학기의 나머지는 내림
        UPDATE timetable SET is_primary = FALSE
         WHERE cadet_id = NEW.cadet_id AND year = NEW.year AND term = NEW.term
           AND id <> NEW.id AND is_primary;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_timetable_set_guard ON timetable;
CREATE TRIGGER trg_timetable_set_guard BEFORE INSERT OR UPDATE ON timetable
    FOR EACH ROW EXECUTE FUNCTION timetable_set_guard();

-- 확정 시간표를 지우면 같은 학기의 최신 시간표를 확정으로 승격(학기에 확정이 사라지지 않게)
CREATE OR REPLACE FUNCTION timetable_repromote() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF OLD.is_primary THEN
        UPDATE timetable SET is_primary = TRUE
         WHERE id = (SELECT id FROM timetable
                      WHERE cadet_id = OLD.cadet_id AND year = OLD.year AND term = OLD.term
                      ORDER BY created_at DESC LIMIT 1);
    END IF;
    RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_timetable_repromote ON timetable;
CREATE TRIGGER trg_timetable_repromote AFTER DELETE ON timetable
    FOR EACH ROW EXECUTE FUNCTION timetable_repromote();

-- 요구사항 ⑰: 한 시간표 안에서 요일·교시 겹침 금지 + 분반 학기 = 시간표 학기.
-- (다른 시간표끼리는 간섭하지 않는다 — 초안은 자유롭게 짜야 하므로)
CREATE OR REPLACE FUNCTION timetable_entry_check() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_year SMALLINT; v_term SMALLINT;
BEGIN
    SELECT t.year, t.term INTO v_year, v_term FROM timetable t WHERE t.id = NEW.timetable_id;
    IF NOT EXISTS (SELECT 1 FROM section s
                    WHERE s.id = NEW.section_id AND s.year = v_year AND s.term = v_term) THEN
        RAISE EXCEPTION '이 시간표(%-%)와 다른 학기의 분반입니다.', v_year, v_term;
    END IF;
    IF EXISTS (
        SELECT 1
        FROM section ns
        JOIN section_time nt ON nt.course_code = ns.course_code AND nt.year = ns.year
                            AND nt.term = ns.term AND nt.section_no = ns.section_no
        JOIN timetable_entry e ON e.timetable_id = NEW.timetable_id AND e.section_id <> NEW.section_id
        JOIN section es ON es.id = e.section_id
        JOIN section_time et ON et.course_code = es.course_code AND et.year = es.year
                            AND et.term = es.term AND et.section_no = es.section_no
        WHERE ns.id = NEW.section_id
          AND nt.day_of_week = et.day_of_week
          AND nt.start_period <= et.end_period AND nt.end_period >= et.start_period
    ) THEN
        RAISE EXCEPTION '시간표가 겹칩니다. (요일·교시 충돌)';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_timetable_entry_check ON timetable_entry;
CREATE TRIGGER trg_timetable_entry_check BEFORE INSERT ON timetable_entry
    FOR EACH ROW EXECUTE FUNCTION timetable_entry_check();

-- 직접추가 강의 겹침 검사: 같은 시간표·요일에서 분(min) 구간 겹침 거부
-- (직접추가 vs 직접추가 + 직접추가 vs 담긴 분반)
CREATE OR REPLACE FUNCTION custom_class_no_overlap() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM custom_class c
    WHERE c.timetable_id = NEW.timetable_id AND c.id <> NEW.id
      AND c.day_of_week = NEW.day_of_week
      AND NEW.start_min < c.end_min AND c.start_min < NEW.end_min
  ) THEN
    RAISE EXCEPTION 'custom_class overlap: 다른 직접추가 강의와 시간이 겹칩니다' USING ERRCODE = '23P01';
  END IF;
  IF EXISTS (
    SELECT 1 FROM timetable_entry e
    JOIN section s       ON s.id = e.section_id
    JOIN section_time st ON st.course_code = s.course_code AND st.year = s.year
                        AND st.term = s.term AND st.section_no = s.section_no
    JOIN period ps ON ps.no = st.start_period
    JOIN period pe ON pe.no = st.end_period
    WHERE e.timetable_id = NEW.timetable_id
      AND st.day_of_week = NEW.day_of_week
      AND NEW.start_min < (EXTRACT(HOUR FROM pe.end_time)::int * 60 + EXTRACT(MINUTE FROM pe.end_time)::int)
      AND (EXTRACT(HOUR FROM ps.start_time)::int * 60 + EXTRACT(MINUTE FROM ps.start_time)::int) < NEW.end_min
  ) THEN
    RAISE EXCEPTION 'custom_class overlap: 등록한 강의와 시간이 겹칩니다' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_custom_class_no_overlap ON custom_class;
CREATE TRIGGER trg_custom_class_no_overlap BEFORE INSERT OR UPDATE ON custom_class
  FOR EACH ROW EXECUTE FUNCTION custom_class_no_overlap();


-- 학점계산기: 생도별 학기·과목 성적(등급·학점). 본인만(RLS).
-- semester(year,term) 에는 FK 를 걸지 않는다 — 과거 학기 성적은 편람 학기 목록과 무관한
-- 개인 기록이라 카탈로그(학기 개폐)에 영향받지 않아야 한다. credit·grade 는 NULL(미입력) 허용.
-- (과락점수계산기는 서버 저장이 아니라 로컬(localStorage)이라 테이블이 없다.)
CREATE TABLE grade_entry (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cadet_id    UUID     NOT NULL REFERENCES cadet(id) ON DELETE CASCADE,
    year        SMALLINT NOT NULL,
    term        SMALLINT NOT NULL,
    course_name TEXT     NOT NULL CHECK (btrim(course_name) <> '' AND char_length(course_name) <= 60),
    credit      NUMERIC(3,1) CHECK (credit IS NULL OR (credit >= 0 AND credit <= 30)),   -- NULL=미입력
    grade       TEXT CHECK (grade IS NULL OR grade IN
                  ('A+','A0','A-','B+','B0','B-','C+','C0','C-','D+','D0','D-','F')),     -- NULL=미입력
    sort_order  INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_grade_entry_cadet ON grade_entry (cadet_id, year DESC, term DESC, sort_order);


-- 학점계산기: 생도별 학기 등수(학위교육과목/생활·훈련과목 각각 내 등수·총원). 학기당 한 행.
-- grade_entry 와 같은 이유로 semester FK 는 걸지 않는다 — 과거 학기 개인 기록은 카탈로그와 무관.
CREATE TABLE rank_entry (
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
CREATE INDEX idx_rank_entry_cadet ON rank_entry (cadet_id, year DESC, term DESC);


-- =====================================================================
--  5장. 강의평 (과목·교수 조합 참조, 익명)
-- =====================================================================
CREATE TABLE review (
    id                 BIGSERIAL PRIMARY KEY,              -- 강의평ID
    course_code        TEXT NOT NULL REFERENCES course(code) ON DELETE CASCADE,
    professor_code     TEXT REFERENCES professor(code) ON DELETE SET NULL,
    overall            score5 NOT NULL,                    -- 총별점
    workload           score5,                             -- 과제량
    progress           score5,                             -- 수업진도
    difficulty         score5,                             -- 수업난이도
    class_time         score5,                             -- 수업시간
    prof_comment       TEXT,                               -- 교수평
    course_comment     TEXT,                               -- 강의평글
    fail               BOOLEAN,                            -- 과락여부
    teamplay           BOOLEAN,                            -- 팀플여부
    presentation       BOOLEAN,                            -- 발표여부
    like_count         INTEGER NOT NULL DEFAULT 0,         -- 공감수
    report_count       INTEGER NOT NULL DEFAULT 0,         -- 신고수(누적/15분급증 기준 app_setting → 자동삭제)
    report_reviewed_count INTEGER NOT NULL DEFAULT 0,      -- 관리자가 '확인처리'한 시점의 신고수. report_count 가 이보다 커야 검열 신고탭에 노출(새 신고만 재부상, 누적 보존)
    post_password_hash TEXT,                               -- 게시글비밀번호(해시). NULL=비번없음(누구나 삭제)
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(), -- 작성일시
    -- 비번이 걸린 글인가(삭제 UI 분기용). 해시 자체는 클라이언트에 절대 내보내지 않는다(아래 '컬럼 권한' 절)
    -- — 6자 비번의 bcrypt 해시를 목록마다 뿌리면 오프라인 크래킹으로 남의 글을 지울 수 있다.
    -- ※ 위치는 반드시 맨 끝: 라이브에는 ALTER TABLE ADD COLUMN 으로 붙으므로 신규 설치와 컬럼 순서를 맞춘다.
    has_password       BOOLEAN GENERATED ALWAYS AS (post_password_hash IS NOT NULL) STORED
);
CREATE INDEX idx_review_course ON review(course_code);
CREATE INDEX idx_review_prof   ON review(professor_code);
-- 강의평 신고 이벤트(익명·횟수만). 15분 급증 또는 누적 기준(app_setting) → 자동삭제
-- reporter_hash = report_hash('review', review_id) — 신고자 원본 ID 는 저장하지 않고 대상별 솔티드
-- 해시만 둔다(완전 익명 유지). UNIQUE 로 '한 사람이 같은 글을 반복 신고해 혼자 임계치를 채우는' 것을 막는다.
CREATE TABLE review_report (
    id            BIGSERIAL PRIMARY KEY,
    review_id     BIGINT NOT NULL REFERENCES review(id) ON DELETE CASCADE,
    reporter_hash TEXT   NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (review_id, reporter_hash)
);
CREATE INDEX idx_review_report ON review_report(review_id, created_at);


-- =====================================================================
--  6장. 족보 (과목 참조 + 출처학기, 익명) + 첨부파일(약한 개체)
-- =====================================================================
-- 파일 실체는 Cloudflare R2 비공개 버킷에 저장하고, DB에는 메타데이터만 둔다.
-- 첨부파일은 다중값 속성이므로 별도 릴레이션 exam_file 로 분해(1NF·변환규칙5).
CREATE TABLE exam_archive (
    id                 BIGSERIAL PRIMARY KEY,              -- 족보번호
    course_code        TEXT NOT NULL REFERENCES course(code) ON DELETE CASCADE,
    src_year           SMALLINT,                           -- 출처연도
    src_term           SMALLINT,                           -- 출처학기구분
    title              TEXT NOT NULL,                      -- 제목
    exam_type          TEXT,                               -- 시험구분
    description        TEXT,                               -- 설명
    post_password_hash TEXT,                               -- 게시글비밀번호(해시). NULL=비번없음(누구나 삭제)
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(), -- 업로드일시
    has_password       BOOLEAN GENERATED ALWAYS AS (post_password_hash IS NOT NULL) STORED   -- 삭제 UI 분기용(해시는 미노출)
);
CREATE INDEX idx_exam_course ON exam_archive(course_code);

-- 족보 첨부파일 — 족보에 존재 종속인 약한 개체(부분키 seq). 요구사항 ㉗.
CREATE TABLE exam_file (
    exam_id    BIGINT   NOT NULL REFERENCES exam_archive(id) ON DELETE CASCADE,
    seq        SMALLINT NOT NULL CHECK (seq >= 1),  -- 순번(부분키)
    object_key TEXT     NOT NULL UNIQUE,            -- R2 객체 key (후보키 — BCNF)
    file_name  TEXT     NOT NULL,                   -- 파일명(목록·다운로드 표시)
    file_size  BIGINT,                              -- 크기(byte)
    mime_type  TEXT,                                -- MIME 타입
    PRIMARY KEY (exam_id, seq)
);


-- =====================================================================
--  7장. 강의 메모 (분반 종속·휘발성, 익명)
-- =====================================================================
CREATE TABLE class_memo (
    id                 BIGSERIAL PRIMARY KEY,              -- 메모ID
    course_code        TEXT     NOT NULL,
    year               SMALLINT NOT NULL,
    term               SMALLINT NOT NULL,
    section_no         SMALLINT NOT NULL,
    content            TEXT NOT NULL,                      -- 내용
    report_count       INTEGER NOT NULL DEFAULT 0,         -- 신고수
    report_reviewed_count INTEGER NOT NULL DEFAULT 0,      -- 관리자 '확인처리' 시점 신고수(report_count 초과분만 신고탭 노출)
    post_password_hash TEXT,                               -- 게시글비밀번호(해시). NULL=비번없음(누구나 삭제)
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(), -- 작성일시
    has_password       BOOLEAN GENERATED ALWAYS AS (post_password_hash IS NOT NULL) STORED,  -- 삭제 UI 분기용(해시는 미노출)
    FOREIGN KEY (course_code, year, term, section_no)
        REFERENCES section(course_code, year, term, section_no) ON DELETE CASCADE
);
CREATE INDEX idx_memo_section ON class_memo(course_code, year, term, section_no);
-- 강의메모 신고 이벤트(익명·횟수만). 15분 급증 또는 누적 기준(app_setting) → 자동삭제
-- reporter_hash: review_report 와 동일한 취지(익명 유지 + 1인 반복신고 차단).
CREATE TABLE memo_report (
    id            BIGSERIAL PRIMARY KEY,
    memo_id       BIGINT NOT NULL REFERENCES class_memo(id) ON DELETE CASCADE,
    reporter_hash TEXT   NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (memo_id, reporter_hash)
);
CREATE INDEX idx_memo_report ON memo_report(memo_id, created_at);


-- =====================================================================
--  구현 보조 (도메인 ERD 외) — 가입게이트 + 설정
-- =====================================================================
-- 단일 설정 행. 가입코드는 1회용이 아니라 '현재 유효한 공용 코드' 하나(해시).
-- 관리자가 바꾸면 즉시 교체되고, 일정 기간 그대로 유지된다.
CREATE TABLE app_setting (
    id               SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    campus_lat       DOUBLE PRECISION NOT NULL,        -- 지오펜싱 중심
    campus_lng       DOUBLE PRECISION NOT NULL,
    radius_m         INTEGER NOT NULL DEFAULT 2000,    -- 허용 반경(m)
    review_min_days  INTEGER NOT NULL DEFAULT 30,      -- 강의평 작성자격(N일 보유; 0=대기 없이 담는 즉시)
    geo_valid_days       INTEGER NOT NULL DEFAULT 90,  -- 위치 재인증 유효기간
    account_delete_days  INTEGER NOT NULL DEFAULT 90,  -- 만료 후 계정삭제 대기
    board_enabled    BOOLEAN NOT NULL DEFAULT TRUE,     -- 익명게시판 전체 활성화
    share_enabled    BOOLEAN NOT NULL DEFAULT TRUE,     -- 공유링크 비회원 열람 허용
    hot_threshold       INTEGER NOT NULL DEFAULT 10,    -- HOT 승격 기준: 30분 내 좋아요/싫어요/댓글 수
    report_delete_count INTEGER NOT NULL DEFAULT 30,    -- 신고 자동삭제: 누적 신고 기준(리뷰·메모·게시글 공통)
    report_burst_count  INTEGER NOT NULL DEFAULT 10,    -- 신고 자동삭제: 15분 내 급증 신고 기준(공통)
    report_salt      TEXT,                             -- 신고자 해시 솔트(report_hash). 서버 전용 — admin-action 의 컬럼 allowlist 에 없어 관리자 화면에도 안 나간다

    signup_code      TEXT,                             -- 현재 공용 가입코드(관리자 표시·변경)
    mod_reviewed_at  TIMESTAMPTZ,                       -- 모더레이션 '모두 확인 처리' 컷오프(이전 글 숨김)
    professors_synced_at TIMESTAMPTZ,                   -- 교수 명단 마지막 동기화 시각(sync-professors)

    -- 카탈로그(교수·학기·과목·교시·공통공강·분반·강의시간)가 바뀔 때마다 +1. bump_catalog_version 트리거가 올린다.
    -- 클라이언트는 이 숫자만 보고 IndexedDB 캐시를 다시 받을지 정한다 → 관리자가 편람을 대규모로 고쳐도
    -- 사용자가 '당겨서 새로고침' 하지 않고 반영되고, 바뀐 게 없으면 아예 내려받지 않는다(egress 절감).
    catalog_version  BIGINT NOT NULL DEFAULT 1
);

-- 관리자 공지사항. 게시 중(활성·만료 전) 공지는 홈 화면 진입 시 팝업으로 표시.
-- 기본 48시간 게시 후 자동 만료. 한 번 본 공지는 기기(localStorage) 기록으로 다시 뜨지 않는다.
-- 작성·수정·삭제는 admin-action(service_role) 전용, 사용자는 게시 중 공지 읽기만(RLS read_notice).
CREATE TABLE notice (
    id         BIGSERIAL PRIMARY KEY,
    title      TEXT NOT NULL,
    content    TEXT NOT NULL,
    is_active  BOOLEAN NOT NULL DEFAULT TRUE,     -- 내리면 팝업에서 즉시 제외(삭제 없이 보관)
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '48 hours'),  -- 게시 마감(기본 48h, 재게시 시 재설정)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now() -- 수정·재게시 시 갱신 → 이미 본 사용자에게도 재표시
);

-- 관리자 금지어. 작성(강의평·메모·게시글·댓글·족보) 시 클라이언트가 내장 비속어 사전과 함께
-- 이 목록도 부분 마스킹(*)한다. 읽기는 authenticated 공개(마스킹에 필요), 추가·삭제는 admin-action(service_role)만.
CREATE TABLE banned_word (
    word       TEXT PRIMARY KEY,                        -- 금지어(대소문자 무시로 매칭). 부분 문자열도 마스킹.
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 정보 수정 제안(correction) — 사용자가 잘못된 교수/과목/분반·시간·강의실을 익명 신고 →
-- 관리자가 검토 후 반영. 작성자 미저장(완전 익명). RLS 정책 없음 → 직접접근 불가:
-- 제출은 submit_correction RPC(SECURITY DEFINER), 조회·처리는 admin-action(service_role).
-- 처리 완료된 제안은 보관하지 않음: 수동 반영/반려 시 admin-action 이 행을 삭제하고,
-- 자동반영 건만 status='applied' 알림으로 남았다가 관리자 확인(ack) 시 삭제.
-- 대상 키는 복합 속성이므로 단순 속성으로 분해해 저장(변환규칙1 비고)하고 FK 로 참조 무결성 보장.
--   target='professor'                 → professor_code
--   target='course'                    → course_code
--   target='section'/'section_time'    → (course_code, year, term, section_no)
CREATE TABLE correction (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    target      TEXT NOT NULL CHECK (target IN ('professor','course','section','section_time','section_add')),
    professor_code TEXT REFERENCES professor(code) ON DELETE CASCADE,   -- 대상 교수
    course_code    TEXT REFERENCES course(code) ON DELETE CASCADE,      -- 대상 과목/분반의 과목
    year           SMALLINT,                                            -- 대상 분반 연도
    term           SMALLINT,                                            -- 대상 분반 학기구분
    section_no     SMALLINT,                                            -- 대상 분반 번호(section_add 는 NULL — 아직 없는 분반)
    label       TEXT,             -- 사람이 읽는 대상(예: "전쟁사 3분반")
    field       TEXT NOT NULL CHECK (field IN ('name','department','office','professor','room','time','section')),
    suggested   TEXT,             -- 제안값(시간은 "수3 수4 금1"; 교수는 "이름 (코드)"; section_add 는 정규화 JSON {no,prof,room,times})
    note        TEXT,             -- 설명
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied')),
    auto_applied  BOOLEAN NOT NULL DEFAULT false,  -- 동일 제안 3건↑ 자동반영으로 처리됨
    prev_value  TEXT,             -- 반영 직전 값(자동반영 알림의 '수정 전' 표시용; 대기중엔 NULL)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (course_code, year, term, section_no)
        REFERENCES section(course_code, year, term, section_no) ON DELETE CASCADE,
    CONSTRAINT correction_target_ref CHECK (
        (target = 'professor' AND professor_code IS NOT NULL AND course_code IS NULL
             AND year IS NULL AND term IS NULL AND section_no IS NULL)
     OR (target = 'course' AND course_code IS NOT NULL AND professor_code IS NULL
             AND year IS NULL AND term IS NULL AND section_no IS NULL)
     OR (target IN ('section','section_time') AND professor_code IS NULL
             AND course_code IS NOT NULL AND year IS NOT NULL
             AND term IS NOT NULL AND section_no IS NOT NULL)
     -- section_add: 아직 없는 분반 제안. section_no 는 NULL 로 둬야 복합 FK(→section)가 걸리지 않는다
     -- (분반번호·교수·시간·강의실은 suggested JSON 에 담고, 반영 때 그 번호로 새 분반을 만든다).
     OR (target = 'section_add' AND professor_code IS NULL
             AND course_code IS NOT NULL AND year IS NOT NULL
             AND term IS NOT NULL AND section_no IS NULL))
);
CREATE INDEX idx_correction_status ON correction (status, created_at DESC);
-- 동일 제안 묶음 카운트/자동반영 조회용
CREATE INDEX idx_correction_dedup ON correction (target, field, status);

-- 수정 제안 1건을 실제 데이터에 반영(공용). 관리자 수동적용(admin-action)과
-- 자동반영(submit_correction, 동일 3건↑)이 같은 로직을 쓰도록 여기 한 곳에 둔다.
-- SECURITY DEFINER + authenticated 미GRANT → 사용자 직접 호출 불가.
-- 반환: 'OK' | 'BAD_TIME' | 'NOT_FOUND' | 'ALREADY_DONE' | 'UNSUPPORTED_FIELD' | 'UNSUPPORTED_TARGET'
CREATE OR REPLACE FUNCTION apply_correction_row(p_id BIGINT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    c        correction%ROWTYPE;
    v        TEXT;
    v_prof   TEXT;
    v_paren  TEXT;
    v_name   TEXT;
    v_room   TEXT;
    v_day    SMALLINT;
    v_a      SMALLINT;
    v_b      SMALLINT;
    tok        TEXT;
    m          TEXT[];
    valid_toks TEXT[];
    v_json     JSONB;      -- section_add 제안값(JSON)
    v_no       SMALLINT;   -- section_add 분반번호
    v_ptxt     TEXT;       -- section_add 교수 표기("이름 (코드)"/"이름 (신규)")
    v_prev     TEXT;       -- 반영 직전 값(자동반영 알림 '수정 전' 표시용)
BEGIN
    SELECT * INTO c FROM correction WHERE id = p_id;
    IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
    IF c.status <> 'pending' THEN RETURN 'ALREADY_DONE'; END IF;
    v := NULLIF(c.suggested, '');

    -- 반영 전 현재값 스냅샷(자동반영 알림에서 '수정 전 → 수정 후'를 보여주기 위함).
    v_prev := NULL;
    IF c.target = 'section' AND c.field = 'professor' THEN
        SELECT COALESCE(p.name, '교수 미정') INTO v_prev
          FROM section s LEFT JOIN professor p ON p.code = s.professor_code
         WHERE s.course_code = c.course_code AND s.year = c.year AND s.term = c.term AND s.section_no = c.section_no;
    ELSIF c.target = 'section_time' AND c.field = 'room' THEN
        SELECT room INTO v_prev FROM section_time
         WHERE course_code = c.course_code AND year = c.year AND term = c.term AND section_no = c.section_no LIMIT 1;
    ELSIF c.target = 'section_time' AND c.field = 'time' THEN
        SELECT string_agg(
                 CASE WHEN start_period = end_period
                      THEN (ARRAY['월','화','수','목','금','토','일'])[day_of_week] || start_period
                      ELSE (ARRAY['월','화','수','목','금','토','일'])[day_of_week] || start_period || '-' || end_period END,
                 ' ' ORDER BY day_of_week, start_period)
          INTO v_prev FROM section_time
         WHERE course_code = c.course_code AND year = c.year AND term = c.term AND section_no = c.section_no;
    ELSIF c.target = 'course' AND c.field = 'name' THEN
        SELECT name INTO v_prev FROM course WHERE code = c.course_code;
    ELSIF c.target = 'professor' THEN
        SELECT CASE c.field WHEN 'name' THEN name WHEN 'department' THEN department WHEN 'office' THEN office END
          INTO v_prev FROM professor WHERE code = c.professor_code;
    END IF;

    IF c.target = 'professor' THEN
        IF c.field = 'name' THEN
            UPDATE professor SET name = v WHERE code = c.professor_code;
        ELSIF c.field = 'department' THEN
            UPDATE professor SET department = v WHERE code = c.professor_code;
        ELSIF c.field = 'office' THEN
            UPDATE professor SET office = v WHERE code = c.professor_code;
        ELSE RETURN 'UNSUPPORTED_FIELD'; END IF;

    ELSIF c.target = 'course' THEN
        IF c.field = 'name' THEN
            UPDATE course SET name = v WHERE code = c.course_code;
        ELSE RETURN 'UNSUPPORTED_FIELD'; END IF;

    ELSIF c.target = 'section' THEN
        IF c.field <> 'professor' THEN RETURN 'UNSUPPORTED_FIELD'; END IF;
        -- 제안값 규칙:
        --   "이름 (코드)" → 기존 교수(코드로 확정, 동명이인 방지)
        --   "이름 (신규)" → 미등록 교수: 새 교수 생성 후 배정(관리자 수동 적용에서만 도달)
        --   그 외         → 이름 매칭(하위호환), 없으면 '교수 미정'(null)
        v_prof := NULL;
        IF v IS NOT NULL THEN
            v_paren := substring(v from '\(([^()]+)\)\s*$');
            IF v_paren = '신규' THEN
                v_name := btrim(regexp_replace(v, '\s*\([^()]*\)\s*$', ''));
                IF v_name <> '' THEN
                    v_prof := gen_professor_code();
                    INSERT INTO professor(code, name) VALUES (v_prof, v_name);
                END IF;
            ELSIF v_paren IS NOT NULL AND EXISTS (SELECT 1 FROM professor WHERE code = v_paren) THEN
                v_prof := v_paren;
            ELSE
                SELECT code INTO v_prof FROM professor WHERE name = btrim(v) LIMIT 1;
            END IF;
        END IF;
        UPDATE section SET professor_code = v_prof
         WHERE course_code = c.course_code AND year = c.year
           AND term = c.term AND section_no = c.section_no;

    ELSIF c.target = 'section_time' THEN
        IF c.field = 'room' THEN
            UPDATE section_time SET room = v
             WHERE course_code = c.course_code AND year = c.year
               AND term = c.term AND section_no = c.section_no;
        ELSIF c.field = 'time' THEN
            -- 유효 토큰(예: "수3-4", "금1")만 먼저 수집. 하나도 없으면 삭제 전에 중단(데이터 보존).
            SELECT array_agg(t) INTO valid_toks
              FROM unnest(regexp_split_to_array(COALESCE(v,''), '[\s,]+')) AS t
             WHERE t ~ '^[월화수목금토일][0-9]+(?:[-~][0-9]+)?$';
            IF valid_toks IS NULL OR array_length(valid_toks, 1) IS NULL THEN RETURN 'BAD_TIME'; END IF;
            -- 기존 강의실 보존 후 교체
            SELECT room INTO v_room FROM section_time
             WHERE course_code = c.course_code AND year = c.year
               AND term = c.term AND section_no = c.section_no
             LIMIT 1;
            DELETE FROM section_time
             WHERE course_code = c.course_code AND year = c.year
               AND term = c.term AND section_no = c.section_no;
            FOREACH tok IN ARRAY valid_toks LOOP
                m := regexp_match(tok, '^([월화수목금토일])([0-9]+)(?:[-~]([0-9]+))?$');
                v_day := array_position(ARRAY['월','화','수','목','금','토','일'], m[1]);
                v_a := m[2]::int;
                v_b := COALESCE(m[3], m[2])::int;
                IF v_b < v_a THEN v_a := COALESCE(m[3], m[2])::int; v_b := m[2]::int; END IF;
                INSERT INTO section_time(course_code, year, term, section_no, day_of_week, start_period, end_period, room)
                VALUES (c.course_code, c.year, c.term, c.section_no,
                        v_day, v_a, v_b, v_room)
                ON CONFLICT (course_code, year, term, section_no, day_of_week, start_period) DO NOTHING;
            END LOOP;
        ELSE RETURN 'UNSUPPORTED_FIELD'; END IF;

    ELSIF c.target = 'section_add' THEN
        -- 제안값은 정규화 JSON: {"no":3,"prof":"이름 (코드)|이름 (신규)|","room":"302","times":"수3-4 금1"}
        IF v IS NULL THEN RETURN 'BAD_TIME'; END IF;
        BEGIN v_json := v::jsonb; EXCEPTION WHEN others THEN RETURN 'BAD_TIME'; END;
        v_no := NULLIF(v_json->>'no','')::smallint;
        IF v_no IS NULL OR v_no < 1 THEN RETURN 'NOT_FOUND'; END IF;
        -- 이미 있는 분반이면 덮어쓰지 않는다(제안이 도착하는 사이 관리자가 만들었을 수 있음).
        IF EXISTS (SELECT 1 FROM section WHERE course_code = c.course_code
                     AND year = c.year AND term = c.term AND section_no = v_no) THEN
            UPDATE correction SET status = 'applied' WHERE id = c.id;
            RETURN 'ALREADY_DONE';
        END IF;
        -- 교수 해석: "이름 (코드)" 기존 / "이름 (신규)" 새로 생성 / 그 외·빈값 → 교수 미정(null)
        v_prof := NULL;
        v_ptxt := NULLIF(v_json->>'prof','');
        IF v_ptxt IS NOT NULL THEN
            v_paren := substring(v_ptxt from '\(([^()]+)\)\s*$');
            IF v_paren = '신규' THEN
                v_name := btrim(regexp_replace(v_ptxt, '\s*\([^()]*\)\s*$', ''));
                IF v_name <> '' THEN
                    v_prof := gen_professor_code();
                    INSERT INTO professor(code, name) VALUES (v_prof, v_name);
                END IF;
            ELSIF v_paren IS NOT NULL AND EXISTS (SELECT 1 FROM professor WHERE code = v_paren) THEN
                v_prof := v_paren;
            ELSE
                SELECT code INTO v_prof FROM professor WHERE name = btrim(v_ptxt) LIMIT 1;
            END IF;
        END IF;
        -- 학기 보장 후 지정된 번호로 분반 생성.
        INSERT INTO semester(year, term) VALUES (c.year, c.term) ON CONFLICT DO NOTHING;
        INSERT INTO section(course_code, year, term, section_no, professor_code)
        VALUES (c.course_code, c.year, c.term, v_no, v_prof);
        -- 강의시간(있으면). 토큰 검증은 time 필드와 동일 규칙.
        v_room := NULLIF(v_json->>'room','');
        SELECT array_agg(t) INTO valid_toks
          FROM unnest(regexp_split_to_array(COALESCE(v_json->>'times',''), '[\s,]+')) AS t
         WHERE t ~ '^[월화수목금토일][0-9]+(?:[-~][0-9]+)?$';
        IF valid_toks IS NOT NULL THEN
            FOREACH tok IN ARRAY valid_toks LOOP
                m := regexp_match(tok, '^([월화수목금토일])([0-9]+)(?:[-~]([0-9]+))?$');
                v_day := array_position(ARRAY['월','화','수','목','금','토','일'], m[1]);
                v_a := m[2]::int;
                v_b := COALESCE(m[3], m[2])::int;
                IF v_b < v_a THEN v_a := COALESCE(m[3], m[2])::int; v_b := m[2]::int; END IF;
                INSERT INTO section_time(course_code, year, term, section_no, day_of_week, start_period, end_period, room)
                VALUES (c.course_code, c.year, c.term, v_no, v_day, v_a, v_b, v_room)
                ON CONFLICT (course_code, year, term, section_no, day_of_week, start_period) DO NOTHING;
            END LOOP;
        END IF;

    ELSE RETURN 'UNSUPPORTED_TARGET'; END IF;

    UPDATE correction SET status = 'applied', prev_value = v_prev WHERE id = c.id;
    RETURN 'OK';
END; $$;

-- 제출(익명): 로그인만 확인하고 작성자는 저장하지 않음.
-- 입력 p_target_key(JSONB)는 전송 형식일 뿐, 저장은 단순 속성으로 분해해서 한다(정규화).
-- 동일(대상·field·suggested) pending 이 3건 이상 쌓이고, 대상이 '분반 단위'
-- (section_time.time/room, section.professor, 그리고 분반추가 section_add)면 자동반영 후
-- 그룹 전체를 auto_applied 로 마킹. section_add 는 신규 교수 생성을 동반해도 자동반영한다.
-- 과목명/교수명/학과(파급 큰 항목)는 자동 제외 → pending 유지(관리자가 수동 검토).
CREATE OR REPLACE FUNCTION submit_correction(
    p_target TEXT, p_target_key JSONB, p_label TEXT,
    p_field TEXT, p_suggested TEXT, p_note TEXT
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_id   BIGINT;
    v_sug  TEXT := NULLIF(p_suggested, '');
    v_cnt  INT;
    v_auto BOOLEAN;
    v_dupes   INT;
    v_applied BOOLEAN := false;   -- 이번 제출로 자동반영이 일어났는가
    v_flabel  TEXT;               -- 항목 한글 라벨(관리자 알림 본문용)
    v_prof TEXT; v_course TEXT; v_year SMALLINT; v_term SMALLINT; v_secno SMALLINT;
    k JSONB := COALESCE(p_target_key, '{}'::jsonb);
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다.'; END IF;
    IF p_target NOT IN ('professor','course','section','section_time','section_add') THEN RAISE EXCEPTION '대상 오류'; END IF;
    IF p_field NOT IN ('name','department','office','professor','room','time','section') THEN RAISE EXCEPTION '항목 오류'; END IF;
    IF p_target = 'professor' THEN
        v_prof := NULLIF(k->>'code', '');
        IF v_prof IS NULL THEN RAISE EXCEPTION '대상 키 오류'; END IF;
    ELSIF p_target = 'course' THEN
        v_course := NULLIF(k->>'code', '');
        IF v_course IS NULL THEN RAISE EXCEPTION '대상 키 오류'; END IF;
    ELSIF p_target = 'section_add' THEN
        -- 아직 없는 분반 제안: 과목·학기만 받고 section_no 는 NULL(복합 FK 미검사 대상).
        v_course := NULLIF(k->>'course_code', '');
        v_year   := (k->>'year')::smallint;
        v_term   := (k->>'term')::smallint;
        IF v_course IS NULL OR v_year IS NULL OR v_term IS NULL THEN
            RAISE EXCEPTION '대상 키 오류'; END IF;
    ELSE
        v_course := NULLIF(k->>'course_code', '');
        v_year   := (k->>'year')::smallint;
        v_term   := (k->>'term')::smallint;
        v_secno  := (k->>'section_no')::smallint;
        IF v_course IS NULL OR v_year IS NULL OR v_term IS NULL OR v_secno IS NULL THEN
            RAISE EXCEPTION '대상 키 오류'; END IF;
    END IF;
    INSERT INTO correction(target, professor_code, course_code, year, term, section_no,
                           label, field, suggested, note)
    VALUES (p_target, v_prof, v_course, v_year, v_term, v_secno,
            NULLIF(p_label,''), p_field, v_sug, NULLIF(p_note,''))
    RETURNING id INTO v_id;

    -- 같은 제안이 처음 들어온 건지(방금 넣은 1건 포함 count=1) — 새 제안 푸시를 중복 제출로 도배하지 않게.
    SELECT count(*) INTO v_dupes FROM correction
     WHERE status = 'pending' AND target = p_target AND field = p_field
       AND suggested IS NOT DISTINCT FROM v_sug
       AND professor_code IS NOT DISTINCT FROM v_prof
       AND course_code IS NOT DISTINCT FROM v_course
       AND year IS NOT DISTINCT FROM v_year
       AND term IS NOT DISTINCT FROM v_term
       AND section_no IS NOT DISTINCT FROM v_secno;

    -- 자동반영 대상(분반 단위)인지 판단.
    -- 교수 재배정은 '기존 교수(코드 확정)'일 때만 자동 — 신규 교수 생성은 익명 자동에서 제외(스팸 방지).
    -- 분반추가(section_add)는 관리자 승인 없이도 3건↑면 자동 생성한다(신규 교수 동반도 포함).
    v_auto := (p_target = 'section_time' AND p_field IN ('time','room'))
           OR (p_target = 'section'      AND p_field = 'professor'
               AND EXISTS (SELECT 1 FROM professor WHERE code = substring(v_sug from '\(([^()]+)\)\s*$')))
           OR (p_target = 'section_add');
    IF v_auto AND v_sug IS NOT NULL THEN
        -- section_add 는 section_no 가 NULL 이라 '=' 로는 안 묶인다 → IS NOT DISTINCT FROM 으로 NULL 안전 비교.
        SELECT count(*) INTO v_cnt FROM correction
         WHERE status = 'pending' AND target = p_target AND field = p_field AND suggested = v_sug
           AND course_code = v_course AND year = v_year AND term = v_term
           AND section_no IS NOT DISTINCT FROM v_secno;
        IF v_cnt >= 3 THEN
            -- 대표 1건만 실제 반영하고, 동일 그룹 전체를 자동반영 처리로 마킹.
            PERFORM apply_correction_row(v_id);
            UPDATE correction SET status = 'applied', auto_applied = true
             WHERE status = 'pending' AND target = p_target AND field = p_field AND suggested = v_sug
               AND course_code = v_course AND year = v_year AND term = v_term
               AND section_no IS NOT DISTINCT FROM v_secno;
            UPDATE correction SET auto_applied = true WHERE id = v_id;  -- 대표건도 표시
            v_applied := true;
        END IF;
    END IF;

    -- 관리자 푸시(내부에서 실패 삼킴). 자동반영이 일어났으면 그 알림, 아니면 '이번이 처음인' 제안만 알린다.
    v_flabel := CASE p_field
        WHEN 'time' THEN '요일·교시' WHEN 'room' THEN '강의실' WHEN 'professor' THEN '담당교수'
        WHEN 'name' THEN '이름/과목명' WHEN 'department' THEN '학과' WHEN 'office' THEN '연구실'
        WHEN 'section' THEN '분반 추가' ELSE p_field END;
    IF v_applied THEN
        PERFORM admin_push('auto_correction', '🤖 수정제안 자동반영됨',
                           COALESCE(NULLIF(p_label,''), '대상') || ' · ' || v_flabel);
    ELSIF v_dupes = 1 THEN
        PERFORM admin_push('correction', '🚩 새 수정 제안',
                           COALESCE(NULLIF(p_label,''), '대상') || ' · ' || v_flabel);
    END IF;
    RETURN v_id;
END; $$;
GRANT EXECUTE ON FUNCTION submit_correction(TEXT,JSONB,TEXT,TEXT,TEXT,TEXT) TO authenticated;


-- =====================================================================
--  뷰 (유도속성: 과락률 / 평점 집계 / 등급)
-- =====================================================================
CREATE VIEW course_professor_rating
WITH (security_invoker = true) AS
SELECT
    r.course_code, c.name AS course_name,
    r.professor_code, p.name AS professor_name,
    COUNT(*)                              AS review_count,
    ROUND(AVG(r.overall), 2)             AS avg_overall,
    ROUND(AVG(r.workload), 2)            AS avg_workload,
    ROUND(AVG(r.progress), 2)            AS avg_progress,
    ROUND(AVG(r.difficulty), 2)          AS avg_difficulty,
    ROUND(AVG(r.class_time), 2)          AS avg_class_time,
    ROUND(AVG((r.fail)::int)::numeric, 2) AS fail_ratio   -- 과락률(미저장)
FROM review r
JOIN course c ON c.code = r.course_code
LEFT JOIN professor p ON p.code = r.professor_code
GROUP BY r.course_code, c.name, r.professor_code, p.name;

CREATE VIEW professor_rating
WITH (security_invoker = true) AS
SELECT r.professor_code, p.name AS professor_name,
    COUNT(*) AS review_count,
    ROUND(AVG(r.overall), 2) AS avg_overall,
    ROUND(AVG((r.fail)::int)::numeric, 2) AS fail_ratio
FROM review r JOIN professor p ON p.code = r.professor_code
WHERE r.professor_code IS NOT NULL
GROUP BY r.professor_code, p.name;

-- (레벨/뱃지는 cadet.post_count 로 앱(components/Badge.jsx의 badgeOf)에서 계산 — 별도 뷰 없음)


-- =====================================================================
--  RLS
-- =====================================================================
ALTER TABLE cadet        ENABLE ROW LEVEL SECURITY;
ALTER TABLE professor    ENABLE ROW LEVEL SECURITY;
ALTER TABLE semester     ENABLE ROW LEVEL SECURITY;
ALTER TABLE course       ENABLE ROW LEVEL SECURITY;
ALTER TABLE period       ENABLE ROW LEVEL SECURITY;
ALTER TABLE common_block ENABLE ROW LEVEL SECURITY;
ALTER TABLE section      ENABLE ROW LEVEL SECURITY;
ALTER TABLE section_time ENABLE ROW LEVEL SECURITY;
ALTER TABLE timetable       ENABLE ROW LEVEL SECURITY;
ALTER TABLE timetable_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_class    ENABLE ROW LEVEL SECURITY;
ALTER TABLE grade_entry     ENABLE ROW LEVEL SECURITY;
ALTER TABLE rank_entry      ENABLE ROW LEVEL SECURITY;
ALTER TABLE review        ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_report ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_archive  ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_file     ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_memo    ENABLE ROW LEVEL SECURITY;
ALTER TABLE memo_report   ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_setting  ENABLE ROW LEVEL SECURITY;
ALTER TABLE notice       ENABLE ROW LEVEL SECURITY;
ALTER TABLE banned_word  ENABLE ROW LEVEL SECURITY;
ALTER TABLE correction   ENABLE ROW LEVEL SECURITY;

CREATE POLICY read_professor ON professor    FOR SELECT TO authenticated USING (true);
CREATE POLICY read_semester  ON semester     FOR SELECT TO authenticated USING (true);
CREATE POLICY read_course    ON course       FOR SELECT TO authenticated USING (true);
CREATE POLICY read_period    ON period       FOR SELECT TO authenticated USING (true);
CREATE POLICY read_common_blk ON common_block FOR SELECT TO authenticated USING (true);
CREATE POLICY read_section   ON section      FOR SELECT TO authenticated USING (true);
CREATE POLICY read_sec_time  ON section_time FOR SELECT TO authenticated USING (true);
CREATE POLICY read_review    ON review       FOR SELECT TO authenticated USING (true);
CREATE POLICY read_exam      ON exam_archive FOR SELECT TO authenticated USING (true);
CREATE POLICY read_exam_file ON exam_file    FOR SELECT TO authenticated USING (true);
CREATE POLICY read_notice    ON notice       FOR SELECT TO authenticated USING (is_active AND expires_at > now());
CREATE POLICY read_banned_word ON banned_word FOR SELECT TO authenticated USING (true);   -- 작성 시 클라이언트 마스킹에 필요(쓰기는 service_role 만)
CREATE POLICY read_own_cadet ON cadet        FOR SELECT TO authenticated USING (id = auth.uid());
CREATE POLICY own_timetable  ON timetable    FOR ALL TO authenticated
    USING (cadet_id = auth.uid()) WITH CHECK (cadet_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON timetable TO authenticated;
-- 담긴 분반·직접추가는 '그 시간표가 내 것인가'로 판정(소유자는 timetable 이 들고 있다)
CREATE POLICY own_tt_entry ON timetable_entry FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM timetable t WHERE t.id = timetable_id AND t.cadet_id = auth.uid()))
    WITH CHECK (EXISTS (SELECT 1 FROM timetable t WHERE t.id = timetable_id AND t.cadet_id = auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON timetable_entry TO authenticated;
CREATE POLICY own_custom_class ON custom_class FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM timetable t WHERE t.id = timetable_id AND t.cadet_id = auth.uid()))
    WITH CHECK (EXISTS (SELECT 1 FROM timetable t WHERE t.id = timetable_id AND t.cadet_id = auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON custom_class TO authenticated;
-- 학점계산기 성적: 본인 행만(timetable 과 동일 패턴)
CREATE POLICY own_grade_entry ON grade_entry FOR ALL TO authenticated
    USING (cadet_id = auth.uid()) WITH CHECK (cadet_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON grade_entry TO authenticated;
-- 학점계산기 등수: 본인 행만(grade_entry 와 동일 패턴)
CREATE POLICY own_rank_entry ON rank_entry FOR ALL TO authenticated
    USING (cadet_id = auth.uid()) WITH CHECK (cadet_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON rank_entry TO authenticated;
-- class_memo / app_setting / correction : 정책 없음 → 서버 함수(RPC/service_role)만.
-- review_report / memo_report : 정책 없음(deny-all) → report_review()/report_memo() RPC 와
--   admin-action(service_role) 만 접근. RLS 를 빠뜨리면 Supabase 기본 GRANT 때문에
--   anon 이 신고행을 직접 INSERT·DELETE 할 수 있어 임의 글 자동삭제/신고은폐가 가능해진다.
-- notice : 읽기(활성만)만 정책, 쓰기 정책 없음 → 작성·수정·삭제는 admin-action(service_role)만.
-- banned_word : 읽기만 공개(마스킹용), 쓰기 정책 없음 → 추가·삭제는 admin-action(service_role)만.
-- (관리자 여부 cadet.is_admin 은 본인 행 select 로만 노출, 변경은 service_role 만)


-- =====================================================================
--  함수: 가입 게이트
-- =====================================================================
CREATE OR REPLACE FUNCTION is_admin() RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE((SELECT is_admin FROM cadet WHERE id = auth.uid()), FALSE);
$$;
GRANT EXECUTE ON FUNCTION is_admin() TO authenticated;

CREATE OR REPLACE FUNCTION haversine_m(
    lat1 DOUBLE PRECISION, lng1 DOUBLE PRECISION, lat2 DOUBLE PRECISION, lng2 DOUBLE PRECISION
) RETURNS DOUBLE PRECISION LANGUAGE sql IMMUTABLE SET search_path = public AS $$
    SELECT 2 * 6371000 * asin(sqrt(power(sin(radians(lat2-lat1)/2),2)
        + cos(radians(lat1))*cos(radians(lat2))*power(sin(radians(lng2-lng1)/2),2)));
$$;

-- 가입 게이트: 현재 공용 코드 일치 + 지오펜싱. 코드는 소모하지 않음(공용·기간유지).
CREATE OR REPLACE FUNCTION verify_gate(
    p_code TEXT, p_lat DOUBLE PRECISION, p_lng DOUBLE PRECISION
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_set app_setting%ROWTYPE; v_dist DOUBLE PRECISION;
BEGIN
    SELECT * INTO v_set FROM app_setting WHERE id = 1;
    IF v_set.signup_code IS NULL
       OR lower(btrim(p_code)) <> lower(btrim(v_set.signup_code)) THEN
        RETURN 'INVALID_CODE';
    END IF;
    IF p_lat IS NULL OR p_lng IS NULL THEN RETURN 'OUT_OF_AREA'; END IF;  -- 위치 필수
    v_dist := haversine_m(v_set.campus_lat, v_set.campus_lng, p_lat, p_lng);
    IF v_dist > v_set.radius_m THEN RETURN 'OUT_OF_AREA'; END IF;
    RETURN 'OK';
END;
$$;
REVOKE ALL ON FUNCTION verify_gate(TEXT,DOUBLE PRECISION,DOUBLE PRECISION) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION verify_gate(TEXT,DOUBLE PRECISION,DOUBLE PRECISION) TO service_role;

-- 관리자: 가입코드 변경(service_role 전용).
CREATE OR REPLACE FUNCTION set_signup_code(p_code TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    UPDATE app_setting SET signup_code = btrim(p_code) WHERE id = 1;
END;
$$;
REVOKE ALL ON FUNCTION set_signup_code(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION set_signup_code(TEXT) TO service_role;

-- 강의평 작성자격 기준일 조회(앱 UI 그레이아웃용). 로그인 사용자.
-- ⚠️ 사용 중단: 이 값은 이제 get_boot_info 에 함께 실려 온다(메모 화면마다 왕복하던 것을 없앴다).
--    아직 옛 프론트(서비스워커 캐시)가 남아 있을 수 있어 함수는 남겨 둔다 — 실패해도 기본값 30 으로 굴러간다.
CREATE OR REPLACE FUNCTION get_review_min_days() RETURNS INTEGER
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE((SELECT review_min_days FROM app_setting WHERE id = 1), 30);
$$;
GRANT EXECUTE ON FUNCTION get_review_min_days() TO authenticated;

-- 과목코드 자동 생성(겹침 방지)
CREATE OR REPLACE FUNCTION gen_course_code() RETURNS TEXT
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE c TEXT;
BEGIN
    LOOP
        c := 'C' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 7));
        EXIT WHEN NOT EXISTS (SELECT 1 FROM course WHERE code = c);
    END LOOP;
    RETURN c;
END;
$$;
CREATE OR REPLACE FUNCTION gen_professor_code() RETURNS TEXT
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE c TEXT;
BEGIN
    LOOP
        c := 'P' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
        EXIT WHEN NOT EXISTS (SELECT 1 FROM professor WHERE code = c);
    END LOOP;
    RETURN c;
END;
$$;

-- 교수 통합(중복 정리). 일괄등록(CSV·편람)이 이름 문자열만 보고 매칭하는 탓에 같은 사람이
-- 두 벌로 생긴다 — "Justin"/"Justin Bunting"(성 누락), "유 훈"/"유훈"(외자 띄어쓰기).
-- p_from 을 참조하던 분반·강의평·수정제안을 p_into 로 옮기고 p_from 을 지운다.
-- 여러 테이블을 건드리므로 함수 하나(=단일 트랜잭션)로 둔다 — 중간에 실패하면 통째로 롤백,
-- '분반은 옮겼는데 교수는 안 지워진' 상태가 남지 않는다.
-- professor 를 그냥 DELETE 하면 section·review 의 FK 가 ON DELETE SET NULL 이라 강의·강의평이
-- '교수 미정'이 되어 버린다 — 통합은 반드시 이 함수로.
-- 학과·연구실은 남기는 쪽이 비어 있을 때만 흡수한다(있는 값을 덮어쓰지 않는다).
-- SECURITY DEFINER + service_role 만 GRANT → admin-action(관리자 검증 후)으로만 호출된다.
-- 반환: {status:'OK', name, sections, reviews, corrections} | {status:'BAD_REQUEST'|'NOT_FOUND'}
CREATE OR REPLACE FUNCTION merge_professor(p_from TEXT, p_into TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name TEXT; v_sec INT; v_rev INT; v_cor INT;
BEGIN
    IF p_from IS NULL OR p_into IS NULL OR p_from = p_into THEN
        RETURN jsonb_build_object('status', 'BAD_REQUEST');
    END IF;
    SELECT name INTO v_name FROM professor WHERE code = p_from;
    IF NOT FOUND THEN RETURN jsonb_build_object('status', 'NOT_FOUND'); END IF;
    IF NOT EXISTS (SELECT 1 FROM professor WHERE code = p_into) THEN
        RETURN jsonb_build_object('status', 'NOT_FOUND');
    END IF;

    UPDATE section    SET professor_code = p_into WHERE professor_code = p_from;
    GET DIAGNOSTICS v_sec = ROW_COUNT;
    UPDATE review     SET professor_code = p_into WHERE professor_code = p_from;
    GET DIAGNOSTICS v_rev = ROW_COUNT;
    UPDATE correction SET professor_code = p_into WHERE professor_code = p_from;
    GET DIAGNOSTICS v_cor = ROW_COUNT;
    -- 분반 교수 재배정 제안의 제안값("이름 (코드)")에 박힌 옛 코드도 갈아끼운다.
    -- 반영(apply_correction_row)은 괄호 안 코드로 교수를 확정하므로, 두면 '없는 교수'가 되어
    -- 이름 매칭으로 흘러가 엉뚱한 결과가 난다.
    UPDATE correction
       SET suggested = regexp_replace(suggested, '\(' || p_from || '\)\s*$', '(' || p_into || ')')
     WHERE target = 'section' AND field = 'professor'
       AND suggested ~ ('\(' || p_from || '\)\s*$');

    UPDATE professor t
       SET department = COALESCE(t.department, f.department),
           office     = COALESCE(t.office,     f.office)
      FROM professor f
     WHERE t.code = p_into AND f.code = p_from;

    DELETE FROM professor WHERE code = p_from;

    RETURN jsonb_build_object('status', 'OK', 'name', v_name,
        'sections', v_sec, 'reviews', v_rev, 'corrections', v_cor);
END;
$$;
REVOKE ALL ON FUNCTION merge_professor(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION merge_professor(TEXT, TEXT) TO service_role;

-- 지오펜싱 재인증
CREATE OR REPLACE FUNCTION geo_verify(p_lat DOUBLE PRECISION, p_lng DOUBLE PRECISION) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_set app_setting%ROWTYPE; v_dist DOUBLE PRECISION;
BEGIN
    IF auth.uid() IS NULL THEN RETURN 'UNAUTH'; END IF;
    IF p_lat IS NULL OR p_lng IS NULL THEN RETURN 'NO_LOCATION'; END IF;
    SELECT * INTO v_set FROM app_setting WHERE id = 1;
    v_dist := haversine_m(v_set.campus_lat, v_set.campus_lng, p_lat, p_lng);
    IF v_dist > v_set.radius_m THEN RETURN 'OUT_OF_AREA'; END IF;
    UPDATE cadet SET geo_verified_at = now() WHERE id = auth.uid();
    RETURN 'OK';
END;
$$;
GRANT EXECUTE ON FUNCTION geo_verify(DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated;

-- 부팅 시 한 번 읽는 서버 값 묶음(앱이 켜질 때마다 어차피 한 번 부르던 자리다).
-- app_setting 한 행에서 나오는 값들은 전부 여기에 싣는다 — 요청 수는 그대로(1회), 응답만 몇 바이트 늘어난다.
-- 이 자리가 없으면 화면마다 board_enabled()·get_review_min_days() 를 따로 불러
-- 홈·게시판·메모 진입마다 RPC 가 한 번씩 더 나갔다(가장 흔한 화면들이라 그 합이 크다).
-- catalog_version 이 기기 캐시에 찍힌 값과 다르면 그때만 카탈로그를 다시 받는다(lib/cache.js).
CREATE OR REPLACE FUNCTION get_boot_info() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT jsonb_build_object(
        'geo_valid_days',  COALESCE(geo_valid_days, 90),
        'catalog_version', catalog_version,
        'board_enabled',   COALESCE(board_enabled, TRUE),
        'share_enabled',   COALESCE(share_enabled, TRUE),
        'review_min_days', COALESCE(review_min_days, 30)
    ) FROM app_setting WHERE id = 1;
$$;
-- Supabase 는 public 스키마 함수에 기본권한(ALTER DEFAULT PRIVILEGES)으로 anon 에게도 EXECUTE 를 준다
-- → `GRANT ... TO authenticated` 만 써 두면 anon 도 그대로 부를 수 있다(ACL 에 anon=X 가 박힌다).
-- 이 함수는 로그인 뒤에만 부르므로 anon 을 명시적으로 회수한다(verify_gate 와 같은 취지).
REVOKE ALL ON FUNCTION get_boot_info() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_boot_info() TO authenticated;

-- ── 카탈로그 버전: 강의 정보가 바뀌면 전 기기가 알아서 다시 받게 한다 ──────────
-- 문(statement) 단위 트리거라 행 수와 무관하게 한 번만 돈다(일괄등록 수천 행도 UPDATE 1회).
-- 카탈로그 테이블은 RLS 상 사용자에게 읽기 전용이라, 이 트리거는 관리자 경로(service_role)에서만 돈다
-- → 사용자 동작에는 어떤 비용도 얹지 않는다. admin-action 코드를 고칠 필요도 없다(어느 경로로 고쳐도 잡힌다).
CREATE OR REPLACE FUNCTION bump_catalog_version() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    UPDATE app_setting SET catalog_version = catalog_version + 1 WHERE id = 1;
    RETURN NULL;
END;
$$;

CREATE TRIGGER bump_catver AFTER INSERT OR UPDATE OR DELETE ON professor
    FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_version();
CREATE TRIGGER bump_catver AFTER INSERT OR UPDATE OR DELETE ON semester
    FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_version();
CREATE TRIGGER bump_catver AFTER INSERT OR UPDATE OR DELETE ON course
    FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_version();
CREATE TRIGGER bump_catver AFTER INSERT OR UPDATE OR DELETE ON period
    FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_version();
CREATE TRIGGER bump_catver AFTER INSERT OR UPDATE OR DELETE ON common_block
    FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_version();
CREATE TRIGGER bump_catver AFTER INSERT OR UPDATE OR DELETE ON section
    FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_version();
CREATE TRIGGER bump_catver AFTER INSERT OR UPDATE OR DELETE ON section_time
    FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_version();

-- 만료(재인증) + 삭제대기 경과 계정 삭제
CREATE OR REPLACE FUNCTION purge_expired_accounts() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE vd INTEGER; dd INTEGER;
BEGIN
    SELECT geo_valid_days, account_delete_days INTO vd, dd FROM app_setting WHERE id = 1;
    DELETE FROM auth.users WHERE id IN (
        SELECT c.id FROM cadet c WHERE c.geo_verified_at IS NOT NULL
          AND c.geo_verified_at < now() - make_interval(days => COALESCE(vd, 90) + COALESCE(dd, 90)));
END;
$$;


-- =====================================================================
--  함수: 확정시간표 자격 게이트
--  초안 시간표(is_primary=FALSE)는 인정하지 않는다 — 아무 분반이나 초안에 담아
--  익명 수업메모를 열람하는 구멍을 막기 위함.
-- =====================================================================
-- 이 분반이 내 확정 시간표에 있는가
CREATE OR REPLACE FUNCTION in_primary_timetable(
    p_course_code TEXT, p_year SMALLINT, p_term SMALLINT, p_section_no SMALLINT
) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM timetable_entry e
        JOIN timetable t ON t.id = e.timetable_id
        JOIN section   s ON s.id = e.section_id
        WHERE t.cadet_id = auth.uid() AND t.is_primary
          AND s.course_code = p_course_code AND s.year = p_year
          AND s.term = p_term AND s.section_no = p_section_no);
$$;
GRANT EXECUTE ON FUNCTION in_primary_timetable(TEXT,SMALLINT,SMALLINT,SMALLINT) TO authenticated;

-- 이 분반을 확정 시간표에 며칠째 보유 중인가(미등록이면 NULL) — 강의평 자격 표시용
CREATE OR REPLACE FUNCTION timetable_held_days(
    p_course_code TEXT, p_year SMALLINT, p_term SMALLINT, p_section_no SMALLINT
) RETURNS INTEGER
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT FLOOR(EXTRACT(EPOCH FROM (now() - MIN(e.created_at))) / 86400)::int
    FROM timetable_entry e
    JOIN timetable t ON t.id = e.timetable_id
    JOIN section   s ON s.id = e.section_id
    WHERE t.cadet_id = auth.uid() AND t.is_primary
      AND s.course_code = p_course_code AND s.year = p_year
      AND s.term = p_term AND s.section_no = p_section_no;
$$;
GRANT EXECUTE ON FUNCTION timetable_held_days(TEXT,SMALLINT,SMALLINT,SMALLINT) TO authenticated;


-- =====================================================================
--  함수: 게시 RPC (익명, 작성자 비저장. 요구사항 ⑳·㉒·㉓·㉕·㉙)
-- =====================================================================
-- 강의평 작성: 해당 과목(+교수) 분반을 확정시간표에 review_min_days 일 이상 보유한
--              생도만(요구사항 ㉒). 작성 → 누적작성수 +1.
CREATE OR REPLACE FUNCTION create_review(
    p_post_password TEXT, p_course_code TEXT, p_professor_code TEXT,
    p_overall score5, p_workload score5, p_progress score5,
    p_difficulty score5, p_class_time score5,
    p_prof_comment TEXT, p_course_comment TEXT,
    p_fail BOOLEAN, p_teamplay BOOLEAN, p_presentation BOOLEAN
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_id BIGINT; v_min_days INTEGER;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다.'; END IF;
    SELECT review_min_days INTO v_min_days FROM app_setting WHERE id = 1;
    v_min_days := COALESCE(v_min_days, 30);
    IF NOT EXISTS (
        SELECT 1 FROM timetable_entry e
        JOIN timetable t ON t.id = e.timetable_id
        JOIN section   s ON s.id = e.section_id
        WHERE t.cadet_id = auth.uid() AND t.is_primary
          AND s.course_code = p_course_code
          AND (p_professor_code IS NULL OR s.professor_code = p_professor_code)
          AND now() - e.created_at >= make_interval(days => v_min_days)
    ) THEN
        RAISE EXCEPTION '이 강의를 확정시간표에 %일 이상 보유한 생도만 강의평을 작성할 수 있습니다.', v_min_days;
    END IF;
    INSERT INTO review (course_code, professor_code, post_password_hash,
        overall, workload, progress, difficulty, class_time,
        prof_comment, course_comment, fail, teamplay, presentation)
    VALUES (p_course_code, p_professor_code,
        CASE WHEN NULLIF(p_post_password, '') IS NULL THEN NULL
             ELSE extensions.crypt(p_post_password, extensions.gen_salt('bf')) END,
        p_overall, p_workload, p_progress, p_difficulty, p_class_time,
        p_prof_comment, p_course_comment, p_fail, p_teamplay, p_presentation)
    RETURNING id INTO v_id;
    UPDATE cadet SET post_count = post_count + 1 WHERE id = auth.uid();
    RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION create_review(TEXT,TEXT,TEXT,score5,score5,score5,score5,score5,
    TEXT,TEXT,BOOLEAN,BOOLEAN,BOOLEAN) TO authenticated;

CREATE OR REPLACE FUNCTION delete_review(p_id BIGINT, p_post_password TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_hash TEXT;
BEGIN
    SELECT post_password_hash INTO v_hash FROM review WHERE id = p_id;
    IF NOT FOUND THEN RETURN FALSE; END IF;
    -- 비번(해시)이 있으면 일치해야 삭제. NULL이면 비번없는 글이라 누구나 삭제. 관리자는 비번 무관 즉시 삭제.
    IF v_hash IS NOT NULL AND NOT is_admin() AND (p_post_password IS NULL OR extensions.crypt(p_post_password, v_hash) <> v_hash) THEN
        RAISE EXCEPTION '비밀번호가 일치하지 않습니다.'; END IF;
    DELETE FROM review WHERE id = p_id;
    UPDATE cadet SET post_count = GREATEST(post_count - 1, 0) WHERE id = auth.uid();
    RETURN TRUE;
END;
$$;
GRANT EXECUTE ON FUNCTION delete_review(BIGINT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION like_review(p_id BIGINT) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cnt INTEGER;
BEGIN
    UPDATE review SET like_count = like_count + 1 WHERE id = p_id RETURNING like_count INTO v_cnt;
    RETURN v_cnt;
END;
$$;
GRANT EXECUTE ON FUNCTION like_review(BIGINT) TO authenticated;

-- 행위자 해시 — 중복 반응/신고 차단용. 행위자 원본 ID 를 저장하지 않기 위한 장치다(완전 익명 유지).
-- 대상(kind:id)마다 다른 해시가 나오므로 '이 사람이 신고/좋아요한 글 목록'을 뽑을 수 없다.
-- (솔트를 아는 사람이 특정 조합을 대조하는 것까지는 못 막는다 — 중복 차단의 본질적 한계.)
-- authenticated 에게 EXECUTE 를 주지 않는다: 남의 uid 로 해시를 만들어 대조하는 것을 막기 위함.
-- auth.uid() 를 인자로 받지 않고 내부에서 읽는 것도 같은 이유.
CREATE OR REPLACE FUNCTION actor_hash(p_kind TEXT, p_target BIGINT) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
    SELECT encode(digest(auth.uid()::text || ':' || p_kind || ':' || p_target::text || ':'
                         || (SELECT report_salt FROM app_setting WHERE id = 1), 'sha256'), 'hex');
$$;
REVOKE ALL ON FUNCTION actor_hash(TEXT, BIGINT) FROM PUBLIC, anon, authenticated;

-- 강의평 신고(익명). 15분 급증 또는 누적 기준(app_setting) → 자동삭제(차단 없음, 완전익명).
-- 같은 사람이 같은 강의평을 두 번 신고하면 'ALREADY' — 혼자 임계치를 채워 임의 글을 지우지 못한다.
CREATE OR REPLACE FUNCTION report_review(p_id BIGINT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_rc INTEGER; v_burst INTEGER; v_del INTEGER; v_burst_lim INTEGER;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다.'; END IF;
    IF NOT EXISTS (SELECT 1 FROM review WHERE id = p_id) THEN RETURN 'NOT_FOUND'; END IF;
    INSERT INTO review_report(review_id, reporter_hash)
        VALUES (p_id, actor_hash('review', p_id)) ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN RETURN 'ALREADY'; END IF;
    UPDATE review SET report_count = report_count + 1 WHERE id = p_id RETURNING report_count INTO v_rc;
    SELECT count(*) INTO v_burst FROM review_report
        WHERE review_id = p_id AND created_at > now() - interval '15 minutes';
    SELECT GREATEST(1, COALESCE(report_delete_count, 30)), GREATEST(1, COALESCE(report_burst_count, 10))
        INTO v_del, v_burst_lim FROM app_setting WHERE id = 1;
    IF v_rc >= v_del OR v_burst >= v_burst_lim THEN   -- 삭제 직전 아카이브로 이관(오삭제 복구용) — archive_deleted
        PERFORM archive_deleted('review', p_id, CASE WHEN v_rc >= v_del THEN 'threshold' ELSE 'burst' END);
        PERFORM admin_push('report_deleted', '🗑️ 신고 누적 자동삭제', '강의평 1건이 신고 누적으로 자동삭제되었습니다. 복구가 필요한지 확인하세요.');
        DELETE FROM review WHERE id = p_id; RETURN 'DELETED';
    END IF;
    RETURN 'OK';
END; $$;
GRANT EXECUTE ON FUNCTION report_review(BIGINT) TO authenticated;

-- 족보 작성/삭제 (작성도 누적작성수 +1 / 삭제 -1). 파일 실체는 R2,
-- 첨부 메타데이터는 exam_file 릴레이션에 정규화 저장(다중값 속성 분해).
DROP FUNCTION IF EXISTS create_exam(TEXT,TEXT,SMALLINT,SMALLINT,TEXT,TEXT,TEXT,TEXT);                    -- 구버전
DROP FUNCTION IF EXISTS create_exam(TEXT,TEXT,SMALLINT,SMALLINT,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT);   -- 단일첨부 버전
DROP FUNCTION IF EXISTS create_exam(TEXT,TEXT,SMALLINT,SMALLINT,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,JSONB); -- JSONB 다중첨부 버전
CREATE OR REPLACE FUNCTION create_exam(
    p_post_password TEXT, p_course_code TEXT, p_src_year SMALLINT, p_src_term SMALLINT,
    p_title TEXT, p_exam_type TEXT, p_description TEXT,
    p_files JSONB                                            -- [{key,name,size,mime}, ...]
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_id BIGINT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다.'; END IF;
    IF p_files IS NULL OR jsonb_typeof(p_files) <> 'array' OR jsonb_array_length(p_files) = 0 THEN
        RAISE EXCEPTION '첨부파일이 필요합니다.';
    END IF;
    INSERT INTO exam_archive (course_code, src_year, src_term, title, exam_type, description, post_password_hash)
    VALUES (p_course_code, p_src_year, p_src_term, p_title, p_exam_type, p_description,
        CASE WHEN NULLIF(p_post_password, '') IS NULL THEN NULL
             ELSE extensions.crypt(p_post_password, extensions.gen_salt('bf')) END)
    RETURNING id INTO v_id;
    INSERT INTO exam_file (exam_id, seq, object_key, file_name, file_size, mime_type)
    SELECT v_id, t.ord::smallint, t.f->>'key',
           COALESCE(NULLIF(t.f->>'name',''), '파일'),
           NULLIF(t.f->>'size','')::bigint, NULLIF(t.f->>'mime','')
    FROM jsonb_array_elements(p_files) WITH ORDINALITY AS t(f, ord)
    WHERE COALESCE(t.f->>'key','') <> '';
    UPDATE cadet SET post_count = post_count + 1 WHERE id = auth.uid();
    RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION create_exam(TEXT,TEXT,SMALLINT,SMALLINT,TEXT,TEXT,TEXT,JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION delete_exam(p_id BIGINT, p_post_password TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_hash TEXT;
BEGIN
    SELECT post_password_hash INTO v_hash FROM exam_archive WHERE id = p_id;
    IF NOT FOUND THEN RETURN FALSE; END IF;
    -- 비번(해시)이 있으면 일치해야 삭제. NULL이면 비번없는 글이라 누구나 삭제. 관리자는 비번 무관 즉시 삭제.
    IF v_hash IS NOT NULL AND NOT is_admin() AND (p_post_password IS NULL OR extensions.crypt(p_post_password, v_hash) <> v_hash) THEN
        RAISE EXCEPTION '비밀번호가 일치하지 않습니다.'; END IF;
    DELETE FROM exam_archive WHERE id = p_id;
    UPDATE cadet SET post_count = GREATEST(post_count - 1, 0) WHERE id = auth.uid();
    RETURN TRUE;
END;
$$;
GRANT EXECUTE ON FUNCTION delete_exam(BIGINT, TEXT) TO authenticated;

-- 강의메모: 분반 확정시간표 등록 생도만(요구사항 ㉙). 작성 → +1
CREATE OR REPLACE FUNCTION create_memo(
    p_post_password TEXT, p_course_code TEXT, p_year SMALLINT,
    p_term SMALLINT, p_section_no SMALLINT, p_content TEXT
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_id BIGINT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다.'; END IF;
    IF NOT in_primary_timetable(p_course_code, p_year, p_term, p_section_no) THEN
        RAISE EXCEPTION '확정시간표에 등록한 분반만 메모를 작성할 수 있습니다.'; END IF;
    INSERT INTO class_memo (course_code, year, term, section_no, content, post_password_hash)
    VALUES (p_course_code, p_year, p_term, p_section_no, p_content,
        CASE WHEN NULLIF(p_post_password, '') IS NULL THEN NULL
             ELSE extensions.crypt(p_post_password, extensions.gen_salt('bf')) END)
    RETURNING id INTO v_id;
    UPDATE cadet SET post_count = post_count + 1 WHERE id = auth.uid();
    RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION create_memo(TEXT,TEXT,SMALLINT,SMALLINT,SMALLINT,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION get_memos(
    p_course_code TEXT, p_year SMALLINT, p_term SMALLINT, p_section_no SMALLINT
) RETURNS SETOF class_memo
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT in_primary_timetable(p_course_code, p_year, p_term, p_section_no) THEN
        RAISE EXCEPTION '확정시간표에 등록한 분반만 메모를 볼 수 있습니다.'; END IF;
    -- get_post_b 와 같은 이유로 비밀번호 해시를 비우고 돌려준다(SECURITY DEFINER 는 컬럼 권한을 우회한다).
    RETURN QUERY
        SELECT (jsonb_populate_record(NULL::class_memo, to_jsonb(m) - 'post_password_hash')).*
        FROM class_memo m
        WHERE m.course_code = p_course_code AND m.year = p_year
          AND m.term = p_term AND m.section_no = p_section_no
        ORDER BY m.created_at DESC;
END;
$$;
GRANT EXECUTE ON FUNCTION get_memos(TEXT,SMALLINT,SMALLINT,SMALLINT) TO authenticated;

CREATE OR REPLACE FUNCTION delete_memo(p_id BIGINT, p_post_password TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_hash TEXT;
BEGIN
    SELECT post_password_hash INTO v_hash FROM class_memo WHERE id = p_id;
    IF NOT FOUND THEN RETURN FALSE; END IF;
    -- 비번(해시)이 있으면 일치해야 삭제. NULL이면 비번없는 글이라 누구나 삭제. 관리자는 비번 무관 즉시 삭제.
    IF v_hash IS NOT NULL AND NOT is_admin() AND (p_post_password IS NULL OR extensions.crypt(p_post_password, v_hash) <> v_hash) THEN
        RAISE EXCEPTION '비밀번호가 일치하지 않습니다.'; END IF;
    DELETE FROM class_memo WHERE id = p_id;
    UPDATE cadet SET post_count = GREATEST(post_count - 1, 0) WHERE id = auth.uid();
    RETURN TRUE;
END;
$$;
GRANT EXECUTE ON FUNCTION delete_memo(BIGINT, TEXT) TO authenticated;

-- 강의메모 신고(익명). 15분 급증 또는 누적 기준(app_setting) → 자동삭제(차단 없음, 완전익명).
-- 중복 신고 차단은 report_review 와 동일(reporter_hash + ON CONFLICT → 'ALREADY').
CREATE OR REPLACE FUNCTION report_memo(p_id BIGINT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_rc INTEGER; v_burst INTEGER; v_del INTEGER; v_burst_lim INTEGER;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다.'; END IF;
    IF NOT EXISTS (SELECT 1 FROM class_memo WHERE id = p_id) THEN RETURN 'NOT_FOUND'; END IF;
    INSERT INTO memo_report(memo_id, reporter_hash)
        VALUES (p_id, actor_hash('class_memo', p_id)) ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN RETURN 'ALREADY'; END IF;
    UPDATE class_memo SET report_count = report_count + 1 WHERE id = p_id RETURNING report_count INTO v_rc;
    SELECT count(*) INTO v_burst FROM memo_report
        WHERE memo_id = p_id AND created_at > now() - interval '15 minutes';
    SELECT GREATEST(1, COALESCE(report_delete_count, 30)), GREATEST(1, COALESCE(report_burst_count, 10))
        INTO v_del, v_burst_lim FROM app_setting WHERE id = 1;
    IF v_rc >= v_del OR v_burst >= v_burst_lim THEN   -- 삭제 직전 아카이브로 이관(오삭제 복구용) — archive_deleted
        PERFORM archive_deleted('class_memo', p_id, CASE WHEN v_rc >= v_del THEN 'threshold' ELSE 'burst' END);
        PERFORM admin_push('report_deleted', '🗑️ 신고 누적 자동삭제', '메모 1건이 신고 누적으로 자동삭제되었습니다. 복구가 필요한지 확인하세요.');
        DELETE FROM class_memo WHERE id = p_id; RETURN 'DELETED';
    END IF;
    RETURN 'OK';
END; $$;
GRANT EXECUTE ON FUNCTION report_memo(BIGINT) TO authenticated;


-- =====================================================================
--  족보 파일: Cloudflare R2(비공개 버킷)에 저장. Pages Functions(functions/api/*)가
--  R2 바인딩으로 업로드/다운로드/삭제를 처리(Supabase Storage 미사용).
-- =====================================================================


-- =====================================================================
--  보관정책(네이티브 스케줄) — 요구사항 ㉛(메모 휘발) + ㉘(족보 5년 정리)
--  keep-alive·교수 명단 동기화 등 프로젝트 값(URL·시크릿)이 필요한 크론은 파일 하단 주석 템플릿 참조.
-- =====================================================================
CREATE OR REPLACE FUNCTION purge_past_memos() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    DELETE FROM class_memo m
     WHERE NOT EXISTS (SELECT 1 FROM semester s
        WHERE s.year = m.year AND s.term = m.term AND s.is_current);
END;
$$;

CREATE OR REPLACE FUNCTION purge_old_exams() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    DELETE FROM exam_archive WHERE created_at < now() - interval '5 years';
END;
$$;

DO $$ BEGIN PERFORM cron.unschedule('purge-monthly'); EXCEPTION WHEN others THEN NULL; END $$;
SELECT cron.schedule('purge-monthly', '0 18 1 * *',
    $$ SELECT purge_old_exams(); SELECT purge_past_memos(); SELECT purge_expired_accounts(); $$);


-- =====================================================================
--  익명게시판 (board / post / comment / event) — 운영 확장(명세서 범위 외)
-- =====================================================================
CREATE TABLE board (
    id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 게시판 목록은 최근 활동순으로 훑는다(listBoards). 게시판 수가 늘면 seq scan + sort 가 된다.
CREATE INDEX idx_board_activity ON board (last_activity_at DESC);
CREATE TABLE board_post (
    id BIGSERIAL PRIMARY KEY,
    board_id BIGINT NOT NULL REFERENCES board(id) ON DELETE CASCADE,
    title TEXT, content TEXT NOT NULL, post_password_hash TEXT,   -- NULL=비번없음(누구나 삭제)
    like_count INTEGER NOT NULL DEFAULT 0, dislike_count INTEGER NOT NULL DEFAULT 0,
    comment_count INTEGER NOT NULL DEFAULT 0, report_count INTEGER NOT NULL DEFAULT 0,
    report_reviewed_count INTEGER NOT NULL DEFAULT 0,   -- 관리자 '확인처리' 시점 신고수(report_count 초과분만 신고탭 노출)
    view_count INTEGER NOT NULL DEFAULT 0,               -- 조회수(상세 열람, 기기당 1회 집계)
    hot BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    has_password BOOLEAN GENERATED ALWAYS AS (post_password_hash IS NOT NULL) STORED  -- 삭제 UI 분기용(해시는 미노출)
);
CREATE INDEX idx_bpost_board ON board_post(board_id, created_at DESC);
-- HOT 목록(게시판 홈 최상단): hot=TRUE 만 최신순으로 페이징한다. idx_bpost_board 로는 못 타
-- board_post 전체를 훑고 정렬했다. hot 행만 담는 부분 인덱스라 작고, 필터+정렬을 한 번에 받는다.
CREATE INDEX idx_bpost_hot ON board_post (created_at DESC) WHERE hot;
-- 게시글 이미지 — 게시글에 존재 종속인 약한 개체(부분키 seq). 운영 확장(명세서 범위 외).
-- (구 image_key/image_keys 다중값 속성을 릴레이션으로 분해 — 1NF·변환규칙5)
CREATE TABLE board_post_image (
    post_id    BIGINT   NOT NULL REFERENCES board_post(id) ON DELETE CASCADE,
    seq        SMALLINT NOT NULL CHECK (seq >= 1),  -- 순번(부분키)
    object_key TEXT     NOT NULL UNIQUE,            -- R2 객체 key (후보키 — BCNF)
    PRIMARY KEY (post_id, seq)
);
CREATE TABLE board_comment (
    id BIGSERIAL PRIMARY KEY,
    post_id BIGINT NOT NULL REFERENCES board_post(id) ON DELETE CASCADE,
    parent_id BIGINT REFERENCES board_comment(id) ON DELETE CASCADE,
    content TEXT NOT NULL, post_password_hash TEXT,   -- NULL=비번없음(누구나 삭제)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    has_password BOOLEAN GENERATED ALWAYS AS (post_password_hash IS NOT NULL) STORED  -- 삭제 UI 분기용(해시는 미노출)
);
CREATE INDEX idx_bcomment_post ON board_comment(post_id, created_at);
-- 게시글 이벤트(좋아요/싫어요/신고/댓글). HOT 승격(30분 창)·신고 급증(15분 창) 집계의 원장.
-- actor_hash: 행위자 원본 ID 는 저장하지 않고 대상별 솔티드 해시만 둔다(완전 익명 유지 — actor_hash()).
--   like/dislike/report → 부분 UNIQUE 로 1인 1회. 이게 없으면 한 사람이 좋아요를 연타해
--   아무 글이나 HOT 으로 띄워 전체 푸시를 쏘거나, 신고를 연타해 아무 글이나 지울 수 있다.
--   comment → NULL(한 사람이 여러 댓글을 달 수 있으므로 중복 차단 대상이 아니다).
CREATE TABLE board_event (
    id BIGSERIAL PRIMARY KEY,
    post_id BIGINT NOT NULL REFERENCES board_post(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, actor_hash TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (kind = 'comment' OR actor_hash IS NOT NULL)   -- 비로그인이면 actor_hash() 가 NULL → 여기서 걸린다
);
CREATE INDEX idx_bevent ON board_event(post_id, kind, created_at);
CREATE UNIQUE INDEX uq_bevent_actor ON board_event(post_id, kind, actor_hash) WHERE kind <> 'comment';
-- 게시판 즐겨찾기 (생도별·게시판별, 본인 것만 RLS)
CREATE TABLE board_favorite (
    cadet_id UUID NOT NULL REFERENCES cadet(id) ON DELETE CASCADE,
    board_id BIGINT NOT NULL REFERENCES board(id) ON DELETE CASCADE,
    PRIMARY KEY (cadet_id, board_id)
);

-- 익명게시판 활성 스위치: app_setting.board_enabled(관리자 긴급 차단). 읽기·쓰기 모두 이 값으로 잠근다.
-- 닫히면(false) 읽기 RLS(read_*)가 0행을 돌려주고(완전 차단), 쓰기는 board_enabled_guard 트리거가 막는다.
-- 아래 read 정책들이 이 함수를 참조하므로 정책보다 먼저 정의한다.
-- (값은 get_boot_info 에도 함께 실려 온다 — 앱 진입마다 board_enabled() 를 따로 부르지 않는다.
--  관리자 모더레이션은 service_role(admin-action Edge)이라 RLS 우회 → 닫혀도 계속 동작한다.
--  개별 글 get_post_b·공유 get_shared_post 는 SECURITY DEFINER 라 RLS 를 우회한다 — 앱에서의
--  진입은 프론트 라우트 가드(App.jsx BoardRoute)가 '준비중'으로 막는다.)
CREATE OR REPLACE FUNCTION board_enabled() RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE((SELECT board_enabled FROM app_setting WHERE id = 1), TRUE);
$$;
GRANT EXECUTE ON FUNCTION board_enabled() TO authenticated;

ALTER TABLE board ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_post ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_post_image ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_comment ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_favorite ENABLE ROW LEVEL SECURITY;
-- 읽기도 board_enabled() 로 잠근다: 닫히면 링크/REST 로도 게시판·글·댓글을 읽을 수 없다(완전 차단).
CREATE POLICY read_board ON board FOR SELECT TO authenticated USING (board_enabled());
CREATE POLICY read_bpost ON board_post FOR SELECT TO authenticated USING (board_enabled());
CREATE POLICY read_bpost_image ON board_post_image FOR SELECT TO authenticated USING (board_enabled());
CREATE POLICY read_bcomment ON board_comment FOR SELECT TO authenticated USING (board_enabled());
CREATE POLICY own_fav ON board_favorite FOR ALL TO authenticated
    USING (cadet_id = auth.uid()) WITH CHECK (cadet_id = auth.uid());

-- 익명게시판 비활성화 가드(쓰기): 비활성 상태에서는 새 글/댓글/반응/게시판 생성 차단

CREATE OR REPLACE FUNCTION board_enabled_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NOT COALESCE((SELECT board_enabled FROM app_setting WHERE id = 1), TRUE) THEN
        RAISE EXCEPTION '익명게시판이 비활성화되었습니다.';
    END IF;
    RETURN NEW;
END; $$;
CREATE TRIGGER trg_benabled_board   BEFORE INSERT ON board         FOR EACH ROW EXECUTE FUNCTION board_enabled_guard();
CREATE TRIGGER trg_benabled_post    BEFORE INSERT ON board_post    FOR EACH ROW EXECUTE FUNCTION board_enabled_guard();
CREATE TRIGGER trg_benabled_comment BEFORE INSERT ON board_comment FOR EACH ROW EXECUTE FUNCTION board_enabled_guard();
CREATE TRIGGER trg_benabled_event   BEFORE INSERT ON board_event   FOR EACH ROW EXECUTE FUNCTION board_enabled_guard();

CREATE OR REPLACE FUNCTION create_board(p_name TEXT) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id BIGINT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다.'; END IF;
    INSERT INTO board(name) VALUES (btrim(p_name)) ON CONFLICT (name) DO NOTHING RETURNING id INTO v_id;
    IF v_id IS NULL THEN SELECT id INTO v_id FROM board WHERE name = btrim(p_name); END IF;
    RETURN v_id;
END; $$;
GRANT EXECUTE ON FUNCTION create_board(TEXT) TO authenticated;

DROP FUNCTION IF EXISTS create_post(BIGINT, TEXT, TEXT, TEXT, TEXT);  -- 단일이미지 버전 제거
-- 게시글 작성: 이미지는 board_post_image 릴레이션에 정규화 저장(다중값 속성 분해).
CREATE OR REPLACE FUNCTION create_post(p_board_id BIGINT, p_title TEXT, p_content TEXT, p_password TEXT, p_image_keys TEXT[])
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_id BIGINT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다.'; END IF;
    INSERT INTO board_post(board_id, title, content, post_password_hash)
    VALUES (p_board_id, p_title, p_content,
            CASE WHEN NULLIF(p_password, '') IS NULL THEN NULL
                 ELSE extensions.crypt(p_password, extensions.gen_salt('bf')) END)
    RETURNING id INTO v_id;
    IF p_image_keys IS NOT NULL THEN
        INSERT INTO board_post_image(post_id, seq, object_key)
        SELECT v_id, t.ord::smallint, t.k
        FROM unnest(p_image_keys) WITH ORDINALITY AS t(k, ord)
        WHERE COALESCE(t.k,'') <> '';
    END IF;
    UPDATE board SET last_activity_at = now() WHERE id = p_board_id;
    UPDATE cadet SET post_count = post_count + 1 WHERE id = auth.uid();
    RETURN v_id;
END; $$;
GRANT EXECUTE ON FUNCTION create_post(BIGINT, TEXT, TEXT, TEXT, TEXT[]) TO authenticated;

-- 게시글 상세 조회(+조회수). 기존 단순 SELECT 를 이 RPC 로 치환해 별도 요청 없이(비용 0) 조회수를 센다.
-- p_view=TRUE 일 때만 +1 — 클라이언트가 기기당 1회만 넘긴다(새로고침·반응 후 재조회 인플레 방지).
-- SETOF board_post 반환이라 PostgREST embedded select(board_post_image)를 기존과 동일하게 쓸 수 있다.
-- ※ 이 함수는 SECURITY DEFINER 라 소유자 권한으로 돈다 — 테이블의 컬럼 권한(post_password_hash 회수)이
--   여기엔 걸리지 않는다. 그대로 SETOF board_post 를 돌려주면 호출자가 ?select=post_password_hash 로
--   해시를 그대로 뽑아 갈 수 있다. 그래서 돌려주기 직전에 해시를 비운다(hide_password_hash).
CREATE OR REPLACE FUNCTION get_post_b(p_id BIGINT, p_view BOOLEAN DEFAULT FALSE)
RETURNS SETOF board_post LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다.'; END IF;
    IF p_view THEN
        RETURN QUERY
            WITH u AS (UPDATE board_post SET view_count = view_count + 1 WHERE id = p_id RETURNING *)
            SELECT (jsonb_populate_record(NULL::board_post, to_jsonb(u) - 'post_password_hash')).* FROM u;
    ELSE
        RETURN QUERY
            SELECT (jsonb_populate_record(NULL::board_post, to_jsonb(p) - 'post_password_hash')).*
            FROM board_post p WHERE p.id = p_id;
    END IF;
END; $$;
GRANT EXECUTE ON FUNCTION get_post_b(BIGINT, BOOLEAN) TO authenticated;

CREATE OR REPLACE FUNCTION check_hot(p_post_id BIGINT, p_kind TEXT) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_threshold INTEGER;
BEGIN
    -- HOT 승격 기준은 app_setting.hot_threshold(관리자 설정). 0/음수 방지 위해 최소 1.
    v_threshold := GREATEST(1, COALESCE((SELECT hot_threshold FROM app_setting WHERE id = 1), 10));
    IF (SELECT count(*) FROM board_event WHERE post_id = p_post_id AND kind = p_kind
        AND created_at > now() - interval '30 minutes') >= v_threshold THEN
        UPDATE board_post SET hot = TRUE WHERE id = p_post_id;
    END IF;
END; $$;

-- 좋아요/싫어요/신고 모두 1인 1회(actor_hash + 부분 UNIQUE). 두 번째부터 'ALREADY'.
-- 이게 없으면 한 사람이 자기 토큰으로 RPC 를 연타해 (a) 아무 글이나 HOT 으로 띄워 구독자 전원에게
-- 푸시를 쏘거나 (b) 아무 글이나 신고 임계치로 지울 수 있다. 클라이언트 localStorage 잠금
-- (lib/reactions.js)은 UX 장치일 뿐 서버에는 아무 방어가 아니었다.
CREATE OR REPLACE FUNCTION board_react(p_post_id BIGINT, p_kind TEXT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_board BIGINT; v_rc INTEGER; v_burst INTEGER; v_del INTEGER; v_burst_lim INTEGER; v_hash TEXT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다.'; END IF;
    IF p_kind NOT IN ('like','dislike','report','unlike','undislike') THEN RAISE EXCEPTION 'bad kind'; END IF;
    SELECT board_id INTO v_board FROM board_post WHERE id = p_post_id;
    IF v_board IS NULL THEN RETURN 'NOT_FOUND'; END IF;
    v_hash := actor_hash('board_post', p_post_id);   -- 컬럼 board_event.actor_hash 와 이름이 겹치므로 미리 뽑아 쓴다
    -- 취소(unlike/undislike): 카운트 -1 + '내' 이벤트 제거(HOT 30분 집계 정합).
    -- actor_hash 덕에 남의 이벤트를 지우지 않는다(예전엔 '아무 1건'을 지워 A의 취소가 B의 좋아요를 없앴다).
    -- 내 이벤트가 이미 정리(purge_board, 1일)됐으면 지울 게 없다 — HOT 창(30분)엔 어차피 없으므로 무해.
    -- 신고(report)는 취소 불가(악용 방지). 취소는 last_activity_at 갱신 안 함.
    IF p_kind IN ('unlike','undislike') THEN
        IF p_kind = 'unlike' THEN UPDATE board_post SET like_count = GREATEST(like_count - 1, 0) WHERE id = p_post_id;
        ELSE UPDATE board_post SET dislike_count = GREATEST(dislike_count - 1, 0) WHERE id = p_post_id;
        END IF;
        DELETE FROM board_event
         WHERE post_id = p_post_id AND kind = right(p_kind, -2) AND actor_hash = v_hash;
        RETURN 'OK';
    END IF;
    -- 좋아요·싫어요·신고 모두 행위자 해시를 남긴다. 같은 사람이 같은 글에 같은 반응을 두 번 하면 'ALREADY'.
    INSERT INTO board_event(post_id, kind, actor_hash)
        VALUES (p_post_id, p_kind, v_hash) ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN RETURN 'ALREADY'; END IF;
    IF p_kind = 'like' THEN UPDATE board_post SET like_count = like_count + 1 WHERE id = p_post_id; PERFORM check_hot(p_post_id,'like');
    ELSIF p_kind = 'dislike' THEN UPDATE board_post SET dislike_count = dislike_count + 1 WHERE id = p_post_id; PERFORM check_hot(p_post_id,'dislike');
    ELSE
        UPDATE board_post SET report_count = report_count + 1 WHERE id = p_post_id RETURNING report_count INTO v_rc;
        SELECT count(*) INTO v_burst FROM board_event
            WHERE post_id = p_post_id AND kind = 'report' AND created_at > now() - interval '15 minutes';
        -- 자동삭제 기준은 app_setting(관리자 설정). 누적/급증 각각. 0/음수 방지 위해 최소 1.
        SELECT GREATEST(1, COALESCE(report_delete_count, 30)), GREATEST(1, COALESCE(report_burst_count, 10))
            INTO v_del, v_burst_lim FROM app_setting WHERE id = 1;
        IF v_rc >= v_del OR v_burst >= v_burst_lim THEN   -- 삭제 직전 아카이브로 이관(오삭제 복구용) — archive_deleted
            PERFORM archive_deleted('board_post', p_post_id, CASE WHEN v_rc >= v_del THEN 'threshold' ELSE 'burst' END);
            PERFORM admin_push('report_deleted', '🗑️ 신고 누적 자동삭제', '게시글 1건이 신고 누적으로 자동삭제되었습니다. 복구가 필요한지 확인하세요.');
            DELETE FROM board_post WHERE id = p_post_id; RETURN 'DELETED';
        END IF;
    END IF;
    UPDATE board SET last_activity_at = now() WHERE id = v_board;
    RETURN 'OK';
END; $$;
GRANT EXECUTE ON FUNCTION board_react(BIGINT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION create_comment_b(p_post_id BIGINT, p_parent BIGINT, p_content TEXT, p_password TEXT)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_id BIGINT; v_board BIGINT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다.'; END IF;
    SELECT board_id INTO v_board FROM board_post WHERE id = p_post_id;
    IF v_board IS NULL THEN RAISE EXCEPTION '게시글 없음'; END IF;
    INSERT INTO board_comment(post_id, parent_id, content, post_password_hash)
    VALUES (p_post_id, p_parent, p_content,
        CASE WHEN NULLIF(p_password, '') IS NULL THEN NULL
             ELSE extensions.crypt(p_password, extensions.gen_salt('bf')) END) RETURNING id INTO v_id;
    INSERT INTO board_event(post_id, kind) VALUES (p_post_id, 'comment');
    UPDATE board_post SET comment_count = comment_count + 1 WHERE id = p_post_id;
    PERFORM check_hot(p_post_id, 'comment');
    UPDATE board SET last_activity_at = now() WHERE id = v_board;
    UPDATE cadet SET post_count = post_count + 1 WHERE id = auth.uid();
    RETURN v_id;
END; $$;
GRANT EXECUTE ON FUNCTION create_comment_b(BIGINT, BIGINT, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION delete_post(p_id BIGINT, p_password TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_hash TEXT;
BEGIN
    SELECT post_password_hash INTO v_hash FROM board_post WHERE id = p_id;
    IF NOT FOUND THEN RETURN FALSE; END IF;
    -- 관리자는 비번 무관 즉시 삭제.
    IF v_hash IS NOT NULL AND NOT is_admin() AND (p_password IS NULL OR extensions.crypt(p_password, v_hash) <> v_hash) THEN RAISE EXCEPTION '비밀번호가 일치하지 않습니다.'; END IF;
    DELETE FROM board_post WHERE id = p_id;
    UPDATE cadet SET post_count = GREATEST(post_count - 1, 0) WHERE id = auth.uid();
    RETURN TRUE;
END; $$;
GRANT EXECUTE ON FUNCTION delete_post(BIGINT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION delete_comment_b(p_id BIGINT, p_password TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_hash TEXT; v_post BIGINT;
BEGIN
    SELECT post_password_hash, post_id INTO v_hash, v_post FROM board_comment WHERE id = p_id;
    IF NOT FOUND THEN RETURN FALSE; END IF;
    -- 관리자는 비번 무관 즉시 삭제.
    IF v_hash IS NOT NULL AND NOT is_admin() AND (p_password IS NULL OR extensions.crypt(p_password, v_hash) <> v_hash) THEN RAISE EXCEPTION '비밀번호가 일치하지 않습니다.'; END IF;
    DELETE FROM board_comment WHERE id = p_id;
    UPDATE board_post SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = v_post;
    UPDATE cadet SET post_count = GREATEST(post_count - 1, 0) WHERE id = auth.uid();
    RETURN TRUE;
END; $$;
GRANT EXECUTE ON FUNCTION delete_comment_b(BIGINT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION purge_board() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    DELETE FROM board_post WHERE created_at < now() - interval '90 days';   -- 게시글 90일
    DELETE FROM board WHERE last_activity_at < now() - interval '30 days';  -- 비활성 게시판 30일
    -- 좋아요/싫어요/댓글 이벤트는 HOT 30분 창에만 쓰이므로 1일 후 정리한다. 이때 actor_hash 도 함께
    -- 사라져 하루 뒤엔 같은 사람이 다시 좋아요를 누를 수 있지만, HOT 판정(30분 창)은 영향받지 않는다.
    -- 신고 이벤트는 지우지 않는다 — actor_hash 가 '1인 반복신고 차단'(UNIQUE)의 근거이므로, 이걸 지우면
    -- 하루마다 같은 사람이 같은 글을 다시 신고해 누적 임계치를 채울 수 있다. 게시글 삭제 시 CASCADE 로 정리된다.
    DELETE FROM board_event WHERE kind <> 'report' AND created_at < now() - interval '1 day';
END; $$;
DO $$ BEGIN PERFORM cron.unschedule('purge-board'); EXCEPTION WHEN others THEN NULL; END $$;
SELECT cron.schedule('purge-board', '0 15 * * *', $$ SELECT purge_board(); $$);  -- 매일 KST 자정

-- 게시판 이미지 고아 스윕용: 현재 게시글이 참조 중인 R2 image key 전체(board_post_image).
-- (게시글 삭제/90일 정리 시 DB 행만 지워지고 R2 객체는 남으므로, Cloudflare 스윕이 이 목록과 대조해 정리)
-- 저화질 썸네일은 원본 key + '.thumb' 로 저장되므로(별도 컬럼 없음), 참조 목록에 함께 넣어 스윕이 살아있는 썸네일을 지우지 않게 한다.
-- ⚠️ 시크릿 게이트: 이 함수는 유저 JWT 없이(크론 → Pages Function → anon 키) 불린다. 인자 없이 열어 두면
--    anon 키를 가진 누구나(앱을 연 모든 사람) 게시판 이미지의 R2 key 전체를 받아 갈 수 있었다.
--    push_prune 과 같은 방식으로 서버-서버 공유 시크릿(push_config.fanout_secret)으로 막는다.
CREATE OR REPLACE FUNCTION board_referenced_keys(p_secret TEXT) RETURNS TEXT[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_secret IS NULL OR p_secret IS DISTINCT FROM (SELECT fanout_secret FROM push_config WHERE id = 1) THEN
      RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  RETURN (
    SELECT COALESCE(array_agg(DISTINCT k), '{}')
    FROM (
      SELECT object_key            AS k FROM board_post_image
      UNION ALL
      SELECT object_key || '.thumb' AS k FROM board_post_image
    ) s
  );
END; $$;
GRANT EXECUTE ON FUNCTION board_referenced_keys(TEXT) TO anon;

-- 게시판 이미지 고아 스윕(매일). ※ 도메인·SWEEP_SECRET 로 치환 후 주석 해제.
--   Cloudflare Pages Functions(/api/board-sweep) 가 R2 를 대조·정리한다.
-- DO $$ BEGIN PERFORM cron.unschedule('board-image-sweep'); EXCEPTION WHEN others THEN NULL; END $$;
-- SELECT cron.schedule('board-image-sweep', '30 15 * * *', $$
--   SELECT net.http_post(
--     url     := 'https://anytime.rokafa.app/api/board-sweep',
--     headers := jsonb_build_object('X-Sweep-Secret', '__SWEEP_SECRET__'),
--     body    := '{}'::jsonb);
-- $$);

-- ── 공유 링크 (/s/{token}) ───────────────────────────────────────────
-- 글당 고정 공유 토큰 1개(추측 불가 UUID). 글 삭제(신고 자동삭제·90일 purge_board 포함)
-- 시 CASCADE 소멸 → 링크 즉시 무효. 비회원 열람은 app_setting.share_enabled 로 관리자가
-- 허가/차단(기본 허용). RLS 정책 없음 → 아래 SECURITY DEFINER 함수 전용.
CREATE TABLE board_share (
    post_id    BIGINT PRIMARY KEY REFERENCES board_post(id) ON DELETE CASCADE,
    token      UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE board_share ENABLE ROW LEVEL SECURITY;

-- 공유 토큰 발급(회원 전용). 이미 있으면 기존 토큰 반환(글당 1개 고정).
CREATE OR REPLACE FUNCTION create_share(p_post BIGINT) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_token UUID;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다.'; END IF;
    IF NOT EXISTS (SELECT 1 FROM board_post WHERE id = p_post) THEN RAISE EXCEPTION '게시글 없음'; END IF;
    INSERT INTO board_share(post_id) VALUES (p_post) ON CONFLICT (post_id) DO NOTHING;
    SELECT token INTO v_token FROM board_share WHERE post_id = p_post;
    RETURN v_token;
END; $$;
GRANT EXECUTE ON FUNCTION create_share(BIGINT) TO authenticated;

-- 공유 글 읽기(비회원 포함 — anon GRANT). 토큰 없음/글 삭제 → NULL.
-- 차단 중 + 비회원 → {'disabled':true}. 비번해시·신고수는 절대 미포함(익명·모더레이션 보호).
-- 조회수: p_view=TRUE 이고 비회원일 때만 +1 — 회원은 앱 화면(get_post_b)에서 집계돼 중복 방지.
CREATE OR REPLACE FUNCTION get_shared_post(p_token UUID, p_view BOOLEAN DEFAULT FALSE) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_post BIGINT;
BEGIN
    SELECT post_id INTO v_post FROM board_share WHERE token = p_token;
    IF v_post IS NULL THEN RETURN NULL; END IF;
    IF NOT COALESCE((SELECT share_enabled FROM app_setting WHERE id = 1), TRUE)
       AND auth.uid() IS NULL THEN
        RETURN jsonb_build_object('disabled', true);
    END IF;
    IF p_view AND auth.uid() IS NULL THEN
        UPDATE board_post SET view_count = view_count + 1 WHERE id = v_post;
    END IF;
    RETURN (SELECT jsonb_build_object(
        'post_id', p.id,
        'board', (SELECT b.name FROM board b WHERE b.id = p.board_id),   -- 어느 게시판의 글인지(공유 화면 표시용)
        'post', jsonb_build_object(
            'title', p.title, 'content', p.content, 'created_at', p.created_at,
            'like_count', p.like_count, 'dislike_count', p.dislike_count,
            'comment_count', p.comment_count, 'view_count', p.view_count, 'hot', p.hot),
        'images', COALESCE((SELECT jsonb_agg(jsonb_build_object('seq', i.seq, 'object_key', i.object_key) ORDER BY i.seq)
                            FROM board_post_image i WHERE i.post_id = p.id), '[]'::jsonb),
        'comments', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'parent_id', c.parent_id,
                                'content', c.content, 'created_at', c.created_at) ORDER BY c.created_at)
                              FROM board_comment c WHERE c.post_id = p.id), '[]'::jsonb))
    FROM board_post p WHERE p.id = v_post);
END; $$;
GRANT EXECUTE ON FUNCTION get_shared_post(UUID, BOOLEAN) TO anon, authenticated;

-- 공유 이미지 검증(/api/share-image 전용): 이 토큰이 가리키는 글의 이미지 key 인가
-- (+ 비회원 열람 허용 상태인가). 썸네일(key+'.thumb')도 원본 key 로 판정.
CREATE OR REPLACE FUNCTION share_image_ok(p_token UUID, p_key TEXT) RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE((SELECT share_enabled FROM app_setting WHERE id = 1), TRUE)
       AND EXISTS (SELECT 1 FROM board_share s
                   JOIN board_post_image i ON i.post_id = s.post_id
                   WHERE s.token = p_token
                     AND (i.object_key = p_key OR i.object_key || '.thumb' = p_key));
$$;
GRANT EXECUTE ON FUNCTION share_image_ok(UUID, TEXT) TO anon;


-- =====================================================================
--  웹푸시 (Web Push) — 익명 구독·글 지켜보기(watch)·발송 트리거
--  익명성 원칙: 구독·watch 어디에도 cadet_id 나 타임스탬프를 저장하지 않는다.
--   · endpoint 는 브라우저(푸시서비스)가 발급한 임의 URL — 사람과 연결되지 않음.
--   · 글 작성자를 저장하지 않으므로 "내 글 댓글 알림"은 기기가 로컬(localStorage)로
--     기억한 글을 watch 로 등록하는 방식. watch 는 누구나 아무 글에 걸 수 있어
--     watch = 작성자를 의미하지 않는다(그럴듯한 부인 가능성).
--   · 타임스탬프 미보관 → 글 작성시각과의 상관관계 추적도 차단.
--  발송 경로: 댓글 INSERT / HOT 승격 → pg_net(비동기) → Pages /api/push-fanout.
--  트리거가 30건씩 잘라 호출해 Workers 무료 플랜 서브요청 한도(50/호출)를 지킨다.
-- =====================================================================
CREATE TABLE push_subscription (
    id         BIGSERIAL PRIMARY KEY,
    endpoint   TEXT NOT NULL UNIQUE,             -- 푸시서비스 endpoint URL(기기 익명 식별)
    p256dh     TEXT NOT NULL,                    -- 구독 암호화 공개키(base64url)
    auth       TEXT NOT NULL,                    -- 구독 인증 시크릿(base64url)
    hot_alerts BOOLEAN NOT NULL DEFAULT TRUE     -- HOT 승격 방송 수신 여부(기기별 설정)
);
CREATE TABLE post_watch (
    post_id         BIGINT NOT NULL REFERENCES board_post(id) ON DELETE CASCADE,
    subscription_id BIGINT NOT NULL REFERENCES push_subscription(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, subscription_id)
);
CREATE INDEX idx_watch_sub ON post_watch(subscription_id);

-- 발송 게이트 시크릿(트리거 → Pages /api/push-fanout 호출 인증). 클라이언트 접근 불가.
CREATE TABLE push_config (
    id            SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    fanout_secret TEXT
);

-- 관리자 푸시 구독 — 일반 push_subscription(완전 익명)과 달리 cadet_id 를 저장한다.
-- '관리자에게만' 보내는 알림(새 수정제안·신고 자동삭제·수정제안 자동반영)의 발송 대상.
-- 관리자 기기가 옵트인(관리자 화면 진입)할 때만 쌓이고, 일반 사용자 익명성엔 영향 없다.
CREATE TABLE admin_push_subscription (
    cadet_id  UUID NOT NULL REFERENCES cadet(id) ON DELETE CASCADE,
    endpoint  TEXT NOT NULL,
    p256dh    TEXT NOT NULL,
    auth      TEXT NOT NULL,
    PRIMARY KEY (cadet_id, endpoint)
);
CREATE INDEX idx_admin_push_endpoint ON admin_push_subscription(endpoint);

-- 전면 차단(정책 없음): 클라이언트는 아래 RPC 로만 접근(구독 목록·시크릿 노출 방지).
ALTER TABLE push_subscription       ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_watch              ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_config             ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_push_subscription ENABLE ROW LEVEL SECURITY;

-- 구독 등록/갱신. 로그인은 남용 방지 게이트일 뿐 — uid 는 어디에도 저장하지 않는다.
CREATE OR REPLACE FUNCTION push_subscribe(p_endpoint TEXT, p_p256dh TEXT, p_auth TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다.'; END IF;
    IF p_endpoint NOT LIKE 'https://%' OR length(p_endpoint) > 1024
       OR length(p_p256dh) > 256 OR length(p_auth) > 64 THEN
        RAISE EXCEPTION '잘못된 구독 정보입니다.';
    END IF;
    INSERT INTO push_subscription(endpoint, p256dh, auth) VALUES (p_endpoint, p_p256dh, p_auth)
    ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth;
END; $$;
GRANT EXECUTE ON FUNCTION push_subscribe(TEXT, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION push_unsubscribe(p_endpoint TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다.'; END IF;
    DELETE FROM push_subscription WHERE endpoint = p_endpoint;   -- watch 는 FK CASCADE
END; $$;
GRANT EXECUTE ON FUNCTION push_unsubscribe(TEXT) TO authenticated;

-- HOT 방송 수신 토글(기기별). endpoint 는 추측 불가능한 능력(capability) URL 이라 본인만 안다.
CREATE OR REPLACE FUNCTION push_set_hot(p_endpoint TEXT, p_on BOOLEAN)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다.'; END IF;
    UPDATE push_subscription SET hot_alerts = COALESCE(p_on, TRUE) WHERE endpoint = p_endpoint;
END; $$;
GRANT EXECUTE ON FUNCTION push_set_hot(TEXT, BOOLEAN) TO authenticated;

-- 글 지켜보기 등록/해제 — 댓글 알림의 단위. 작성자 여부와 무관하게 아무 글에나 가능.
CREATE OR REPLACE FUNCTION push_watch(p_endpoint TEXT, p_post_id BIGINT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다.'; END IF;
    IF NOT EXISTS (SELECT 1 FROM board_post WHERE id = p_post_id) THEN RETURN; END IF;
    INSERT INTO post_watch(post_id, subscription_id)
    SELECT p_post_id, s.id FROM push_subscription s WHERE s.endpoint = p_endpoint
    ON CONFLICT DO NOTHING;
END; $$;
GRANT EXECUTE ON FUNCTION push_watch(TEXT, BIGINT) TO authenticated;

CREATE OR REPLACE FUNCTION push_unwatch(p_endpoint TEXT, p_post_id BIGINT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다.'; END IF;
    DELETE FROM post_watch w USING push_subscription s
     WHERE w.subscription_id = s.id AND s.endpoint = p_endpoint AND w.post_id = p_post_id;
END; $$;
GRANT EXECUTE ON FUNCTION push_unwatch(TEXT, BIGINT) TO authenticated;

-- 만료 구독 정리 — 발송자(Pages Function)가 404/410 응답을 받은 endpoint 를 제거.
-- 유저 JWT 가 없는 호출이라 anon 에 열되, fanout 시크릿으로 게이트한다.
CREATE OR REPLACE FUNCTION push_prune(p_secret TEXT, p_endpoints TEXT[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF p_secret IS NULL OR p_secret IS DISTINCT FROM (SELECT fanout_secret FROM push_config WHERE id = 1) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;
    DELETE FROM push_subscription WHERE endpoint = ANY(p_endpoints);
    DELETE FROM admin_push_subscription WHERE endpoint = ANY(p_endpoints);  -- 관리자 구독도 같은 endpoint 로 정리
END; $$;
GRANT EXECUTE ON FUNCTION push_prune(TEXT, TEXT[]) TO anon;

-- 새 댓글 → 그 글의 watcher 들에게 발송. pg_net 은 비동기라 댓글 INSERT 를 지연시키지 않고,
-- 어떤 오류도 삼킨다(알림은 부가기능 — 실패해도 댓글 작성을 막지 않는다).
-- kind: 답글(parent_id 있음)은 'reply', 아니면 'comment' — SW 가 알림 문구를 구분한다.
CREATE OR REPLACE FUNCTION notify_comment_push() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_secret TEXT; v_title TEXT; v_targets JSONB;
BEGIN
    SELECT fanout_secret INTO v_secret FROM push_config WHERE id = 1;
    IF v_secret IS NULL THEN RETURN NEW; END IF;
    SELECT left(COALESCE(NULLIF(btrim(p.title), ''), p.content), 40) INTO v_title
      FROM board_post p WHERE p.id = NEW.post_id;
    FOR v_targets IN
        SELECT jsonb_agg(jsonb_build_object('endpoint', endpoint, 'p256dh', p256dh, 'auth', auth))
          FROM (SELECT s.endpoint, s.p256dh, s.auth, row_number() OVER () AS rn
                  FROM post_watch w JOIN push_subscription s ON s.id = w.subscription_id
                 WHERE w.post_id = NEW.post_id) t
         GROUP BY (rn - 1) / 30
    LOOP
        PERFORM net.http_post(
            url     := 'https://anytime.rokafa.app/api/push-fanout',
            headers := jsonb_build_object('Content-Type', 'application/json', 'X-Push-Secret', v_secret),
            body    := jsonb_build_object('kind', CASE WHEN NEW.parent_id IS NULL THEN 'comment' ELSE 'reply' END,
                                          'post_id', NEW.post_id,
                                          'title', v_title, 'targets', v_targets));
    END LOOP;
    RETURN NEW;
EXCEPTION WHEN others THEN RETURN NEW;
END; $$;
CREATE TRIGGER trg_push_comment AFTER INSERT ON board_comment
    FOR EACH ROW EXECUTE FUNCTION notify_comment_push();

-- HOT 승격(false→true 전이 시 1회) → hot_alerts 켜진 구독 전체에 방송.
CREATE OR REPLACE FUNCTION notify_hot_push() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_secret TEXT; v_title TEXT; v_board TEXT; v_targets JSONB;
BEGIN
    SELECT fanout_secret INTO v_secret FROM push_config WHERE id = 1;
    IF v_secret IS NULL THEN RETURN NEW; END IF;
    v_title := left(COALESCE(NULLIF(btrim(NEW.title), ''), NEW.content), 40);
    SELECT name INTO v_board FROM board WHERE id = NEW.board_id;   -- 알림에 "어느 게시판" 병기용
    FOR v_targets IN
        SELECT jsonb_agg(jsonb_build_object('endpoint', endpoint, 'p256dh', p256dh, 'auth', auth))
          FROM (SELECT endpoint, p256dh, auth, row_number() OVER () AS rn
                  FROM push_subscription WHERE hot_alerts) t
         GROUP BY (rn - 1) / 30
    LOOP
        PERFORM net.http_post(
            url     := 'https://anytime.rokafa.app/api/push-fanout',
            headers := jsonb_build_object('Content-Type', 'application/json', 'X-Push-Secret', v_secret),
            body    := jsonb_build_object('kind', 'hot', 'post_id', NEW.id,
                                          'title', v_title, 'board', v_board, 'targets', v_targets));
    END LOOP;
    RETURN NEW;
EXCEPTION WHEN others THEN RETURN NEW;
END; $$;
CREATE TRIGGER trg_push_hot AFTER UPDATE OF hot ON board_post
    FOR EACH ROW WHEN (OLD.hot IS DISTINCT FROM NEW.hot AND NEW.hot)
    EXECUTE FUNCTION notify_hot_push();

-- ── 관리자 푸시 구독 등록/해제 ──────────────────────────────────────
-- 일반 push_subscribe 와 별개로, 관리자 기기임을 cadet_id 로 표시해 둔다(관리자 화면 진입 시 호출).
-- REVOKE FROM PUBLIC + authenticated 만 GRANT — Supabase 기본권한이 anon 에 새 함수를 여는 함정 방지.
CREATE OR REPLACE FUNCTION admin_push_subscribe(p_endpoint TEXT, p_p256dh TEXT, p_auth TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT is_admin() THEN RETURN; END IF;   -- 관리자 아니면 조용히 무시(비관리자 호출 무해)
    IF p_endpoint NOT LIKE 'https://%' OR length(p_endpoint) > 1024
       OR length(p_p256dh) > 256 OR length(p_auth) > 64 THEN
        RAISE EXCEPTION '잘못된 구독 정보입니다.';
    END IF;
    INSERT INTO admin_push_subscription(cadet_id, endpoint, p256dh, auth)
    VALUES (auth.uid(), p_endpoint, p_p256dh, p_auth)
    ON CONFLICT (cadet_id, endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth;
END; $$;
REVOKE ALL ON FUNCTION admin_push_subscribe(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_push_subscribe(TEXT, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION admin_push_unsubscribe(p_endpoint TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    DELETE FROM admin_push_subscription WHERE cadet_id = auth.uid() AND endpoint = p_endpoint;
END; $$;
REVOKE ALL ON FUNCTION admin_push_unsubscribe(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_push_unsubscribe(TEXT) TO authenticated;

-- 관리자 전원에게 푸시(수정제안·신고삭제·자동반영). 댓글/HOT 트리거와 같은 pg_net → /api/push-fanout
-- 경로를 쓴다(30건씩 청크). SECURITY DEFINER + 미GRANT — 다른 함수 안에서만 호출된다.
-- 알림 클릭 목적지(path)는 관리자 검열 화면 고정. 실패는 삼켜 본 트랜잭션을 막지 않는다.
CREATE OR REPLACE FUNCTION admin_push(p_kind TEXT, p_title TEXT, p_body TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_secret TEXT; v_targets JSONB;
BEGIN
    SELECT fanout_secret INTO v_secret FROM push_config WHERE id = 1;
    IF v_secret IS NULL THEN RETURN; END IF;
    FOR v_targets IN
        SELECT jsonb_agg(jsonb_build_object('endpoint', endpoint, 'p256dh', p256dh, 'auth', auth))
          FROM (SELECT endpoint, p256dh, auth, row_number() OVER () AS rn
                  FROM admin_push_subscription) t
         GROUP BY (rn - 1) / 30
    LOOP
        PERFORM net.http_post(
            url     := 'https://anytime.rokafa.app/api/push-fanout',
            headers := jsonb_build_object('Content-Type', 'application/json', 'X-Push-Secret', v_secret),
            body    := jsonb_build_object('kind', p_kind, 'title', p_title, 'body', p_body,
                                          'path', '/admin/moderation', 'targets', v_targets));
    END LOOP;
EXCEPTION WHEN others THEN RETURN;
END; $$;
-- ⚠️ 내부 전용(다른 SECURITY DEFINER 함수 안에서만 호출). Supabase 기본권한이 anon+authenticated
--   양쪽에 EXECUTE 를 자동부여하므로 명시적으로 전부 회수한다(사용자 직접 호출=관리자 푸시 스푸핑).
REVOKE ALL ON FUNCTION admin_push(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- 발송 시크릿 시드. ※ 라이브 적용 시 실제 값으로 치환(스윕 시크릿과 같은 방식) 후 주석 해제.
--   Cloudflare Pages 환경변수 PUSH_SECRET 과 같은 값이어야 한다.
-- INSERT INTO push_config(id, fanout_secret) VALUES (1, '__PUSH_SECRET__')
--     ON CONFLICT (id) DO UPDATE SET fanout_secret = EXCLUDED.fanout_secret;


-- =====================================================================
--  검열 아카이브 — 신고 누적 자동삭제된 내용의 스냅샷(오삭제 복구 안전망).
--  15분 10건·누적 30건 임계값은 담합/브리게이딩에 취약하므로, 삭제 직전 내용을
--  이 표로 옮겨 관리자가 검토·복구할 수 있게 한다. 작성자 식별정보는 보관하지
--  않는다(완전 익명 — 보관하는 건 '무엇'이지 '누구'가 아님). 30일 뒤 자동 파기.
-- =====================================================================
CREATE TABLE deleted_content (
    id           BIGSERIAL PRIMARY KEY,
    type         TEXT NOT NULL,                   -- review | class_memo | board_post
    orig_id      BIGINT NOT NULL,                 -- 원본 행 id(복구·참조용)
    label        TEXT,                            -- 관리자 표시 맥락(과목코드/게시판명)
    text         TEXT,                            -- 내용 스냅샷(사람이 읽는 텍스트)
    report_count INTEGER NOT NULL DEFAULT 0,      -- 삭제 시점 신고 누적수
    reason       TEXT,                            -- burst_10(15분 10건) | threshold_30(누적 30건) · 구: burst_3/threshold_10
    snapshot     JSONB NOT NULL,                  -- 전체 행 스냅샷(복구용). 작성자 식별정보 없음.
    reviewed     BOOLEAN NOT NULL DEFAULT FALSE,  -- 관리자 확인 여부(미확인 배지용)
    deleted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_deleted_content ON deleted_content(reviewed, deleted_at DESC);
-- 클라이언트 접근 전면 차단(정책 없음). 서비스롤 Edge 만 조회, SECURITY DEFINER 함수는 RLS 우회.
ALTER TABLE deleted_content ENABLE ROW LEVEL SECURITY;

-- 스냅샷 헬퍼 — report_* / board_react 가 삭제 직전 호출(내부 전용).
CREATE OR REPLACE FUNCTION archive_deleted(p_type TEXT, p_id BIGINT, p_reason TEXT DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_text TEXT; v_label TEXT; v_rc INTEGER; v_snap JSONB;
BEGIN
    IF p_type = 'review' THEN
        SELECT to_jsonb(r), r.course_code, r.report_count,
               NULLIF(concat_ws(' / ', r.prof_comment, r.course_comment), '')
          INTO v_snap, v_label, v_rc, v_text FROM review r WHERE r.id = p_id;
    ELSIF p_type = 'class_memo' THEN
        SELECT to_jsonb(m), m.course_code, m.report_count, m.content
          INTO v_snap, v_label, v_rc, v_text FROM class_memo m WHERE m.id = p_id;
    ELSIF p_type = 'board_post' THEN
        -- 이미지 자식 행(board_post_image)도 _images 키로 스냅샷에 포함(복구용)
        SELECT to_jsonb(p) || jsonb_build_object('_images', COALESCE(
                 (SELECT jsonb_agg(jsonb_build_object('seq', i.seq, 'object_key', i.object_key) ORDER BY i.seq)
                    FROM board_post_image i WHERE i.post_id = p.id), '[]'::jsonb)),
               COALESCE(b.name, '게시판'), p.report_count,
               NULLIF(concat_ws(' — ', p.title, p.content), '')
          INTO v_snap, v_label, v_rc, v_text
          FROM board_post p LEFT JOIN board b ON b.id = p.board_id WHERE p.id = p_id;
    ELSE RETURN;
    END IF;
    IF v_snap IS NULL THEN RETURN; END IF;   -- 이미 사라진 행이면 조용히 무시
    INSERT INTO deleted_content(type, orig_id, label, text, report_count, reason, snapshot)
    VALUES (p_type, p_id, v_label, v_text, COALESCE(v_rc, 0), p_reason, v_snap);
END; $$;
REVOKE ALL ON FUNCTION archive_deleted(TEXT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated;

-- 복구 — 스냅샷을 원본 테이블로 재삽입(신고수 0 초기화, 원본 id 보존) 후 아카이브 행 제거.
-- ※ 게시글 복구 시 이미 CASCADE 삭제된 댓글·이벤트는 되살아나지 않음(본문·이미지 행만 복구).
--    이미지 R2 객체가 이미 스윕(고아 정리)됐다면 이미지 표시만 누락된다.
CREATE OR REPLACE FUNCTION restore_deleted(p_arch_id BIGINT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_type TEXT; v_snap JSONB;
BEGIN
    SELECT type, snapshot INTO v_type, v_snap FROM deleted_content WHERE id = p_arch_id;
    IF v_snap IS NULL THEN RETURN 'NOT_FOUND'; END IF;
    v_snap := jsonb_set(v_snap, '{report_count}', '0'::jsonb);   -- 복구 즉시 재삭제 방지
    -- '확인처리' 카운터도 0으로(신고수 0 과 정합). 구 스냅샷엔 키가 없을 수 있어 create_missing 로 보강(NOT NULL 위반 방지).
    v_snap := jsonb_set(v_snap, '{report_reviewed_count}', '0'::jsonb);
    -- view_count(07-08 신설) 도입 전 게시글 스냅샷엔 키가 없어 0 보강(NOT NULL 위반 방지). 있으면 그대로 보존.
    IF v_type = 'board_post' AND NOT v_snap ? 'view_count' THEN
        v_snap := jsonb_set(v_snap, '{view_count}', '0'::jsonb);
    END IF;
    IF v_type = 'review' THEN
        INSERT INTO review SELECT * FROM jsonb_populate_record(NULL::review, v_snap);
    ELSIF v_type = 'class_memo' THEN
        INSERT INTO class_memo SELECT * FROM jsonb_populate_record(NULL::class_memo, v_snap);
    ELSIF v_type = 'board_post' THEN
        INSERT INTO board_post SELECT * FROM jsonb_populate_record(NULL::board_post, v_snap - '_images');
        INSERT INTO board_post_image(post_id, seq, object_key)
        SELECT (v_snap->>'id')::bigint, (i->>'seq')::smallint, i->>'object_key'
        FROM jsonb_array_elements(COALESCE(v_snap->'_images', '[]'::jsonb)) AS i
        ON CONFLICT DO NOTHING;
    ELSE RETURN 'BAD_TYPE';
    END IF;
    DELETE FROM deleted_content WHERE id = p_arch_id;
    RETURN 'OK';
EXCEPTION
    WHEN unique_violation THEN RETURN 'ALREADY_EXISTS';       -- 이미 같은 id 로 복구됨
    WHEN foreign_key_violation THEN RETURN 'PARENT_GONE';     -- 소속 과목/분반/게시판이 이미 정리됨
END; $$;
REVOKE ALL ON FUNCTION restore_deleted(BIGINT) FROM PUBLIC, anon, authenticated;

-- 아카이브 자동 파기(30일) — 매일 KST 00:20. 영구 그림자기록을 남기지 않는다.
CREATE OR REPLACE FUNCTION purge_deleted_archive() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    DELETE FROM deleted_content WHERE deleted_at < now() - interval '30 days';
END; $$;
REVOKE ALL ON FUNCTION purge_deleted_archive() FROM PUBLIC, anon, authenticated;
DO $$ BEGIN PERFORM cron.unschedule('purge-deleted-archive'); EXCEPTION WHEN others THEN NULL; END $$;
SELECT cron.schedule('purge-deleted-archive', '20 15 * * *', $$ SELECT purge_deleted_archive(); $$);


-- =====================================================================
--  인프라 시드 (운영 필수 최소값) — 앱 구동에 반드시 필요한 설정·교시·학기만.
--  실제 카탈로그(교수·과목·분반·강의시간)는 관리자 화면에서 관리.
-- =====================================================================
-- 지오펜싱 좌표·반경 + 강의평 작성자격 일수 + 가입코드 (아래는 예시 자리표시자)
-- ※ 운영 전 실제 좌표·반경·가입코드로 반드시 교체.
INSERT INTO app_setting (id, campus_lat, campus_lng, radius_m, review_min_days, signup_code)
VALUES (1, 0.0, 0.0, 2000, 30, 'CHANGE_ME')
ON CONFLICT (id) DO UPDATE SET campus_lat = EXCLUDED.campus_lat,
    campus_lng = EXCLUDED.campus_lng, radius_m = EXCLUDED.radius_m,
    review_min_days = EXCLUDED.review_min_days,
    signup_code = COALESCE(app_setting.signup_code, EXCLUDED.signup_code);

-- 교시 (생도 일과시간표 편람 기준: 1~4교시 오전, 5~8교시 오후. 총 8교시)
INSERT INTO period (no, start_time, end_time) VALUES
  (1,'08:10','09:00'),(2,'09:10','10:00'),(3,'10:10','11:00'),(4,'11:10','12:00'),
  (5,'13:00','13:50'),(6,'14:00','14:50'),(7,'15:10','16:00'),(8,'16:10','17:00')
  ON CONFLICT (no) DO UPDATE SET start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time;

-- 학기
INSERT INTO semester (year, term, is_current) VALUES
  (2026,1,TRUE),(2025,2,FALSE) ON CONFLICT (year,term) DO NOTHING;


-- =====================================================================
--  keep-alive (무료 플랜 일시정지 방지)  ※ 새 프로젝트 값으로 치환 후 주석 해제
--   __PROJECT_REF__ = 새 Supabase 프로젝트 ref,  __ANON_KEY__ = 새 anon key
-- =====================================================================
-- DO $$ BEGIN PERFORM cron.unschedule('keep-alive'); EXCEPTION WHEN others THEN NULL; END $$;
-- SELECT cron.schedule('keep-alive', '0 6 * * *', $$
--   SELECT net.http_get(url :=
--     'https://__PROJECT_REF__.supabase.co/rest/v1/period?select=no&limit=1&apikey=__ANON_KEY__');
-- $$);

-- =====================================================================
--  교수 명단 주기 동기화 (pg_cron + pg_net → sync-professors Edge Function)
--  공사 공식 홈페이지에서 교수 명단을 크롤·반영(추가·학과변경만, 삭제 없음).
--  ※ 값 치환 후 주석 해제해 Run — 시크릿을 SQL 파일에 남기지 말 것(치환본 저장 금지).
--   사전:  supabase functions deploy sync-professors --no-verify-jwt
--          supabase secrets set SYNC_SECRET='<임의의-긴-랜덤-문자열>'
--   __PROJECT_REF__ = Supabase 프로젝트 ref,  __SYNC_SECRET__ = 위 시크릿 값
-- =====================================================================
-- DO $$ BEGIN PERFORM cron.unschedule('sync-professors'); EXCEPTION WHEN others THEN NULL; END $$;
-- SELECT cron.schedule('sync-professors', '0 0 1 * *', $$   -- 매월 1일 09:00 KST
--   SELECT net.http_post(
--     url     := 'https://__PROJECT_REF__.supabase.co/functions/v1/sync-professors',
--     headers := jsonb_build_object('Content-Type', 'application/json',
--                                   'x-sync-secret', '__SYNC_SECRET__'),
--     body    := '{}'::jsonb,
--     timeout_milliseconds := 120000);
-- $$);

-- =====================================================================
--  비회원(anon) 함수 실행 차단 — ⚠️ 반드시 모든 함수 정의 뒤(파일 최하단)에서 실행할 것.
-- =====================================================================
-- Supabase 는 public 스키마 함수의 EXECUTE 를 PUBLIC 과 anon 양쪽에 기본 부여한다. 그래서 로그인
-- 가드(auth.uid() IS NULL)가 없는 함수(delete_*, like_review 등)는 비회원이 anon 키로 직접 호출해
-- 글을 지우거나 좋아요를 조작할 수 있었다. → 전체 회수 후, 비회원이 정당하게 써야 하는 함수만 재부여.
-- 새 함수를 추가하면 이 블록이 다시 훑어 anon 을 정리하도록, 반드시 파일 맨 끝에 유지한다.
-- (개별 함수의 GRANT ... TO authenticated 는 그대로 유지된다 — PUBLIC·anon 만 회수하므로.)
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;
-- 비회원 공유 열람 경로(비회원도 호출) — get_shared_post: 공유 링크, share_image_ok: OG 이미지,
-- board_referenced_keys: R2 고아 스윕(Pages Function 이 anon 키+시크릿), push_prune: 푸시 정리(anon 키+시크릿).
GRANT EXECUTE ON FUNCTION get_shared_post(UUID, BOOLEAN) TO anon;
GRANT EXECUTE ON FUNCTION share_image_ok(UUID, TEXT)     TO anon;
GRANT EXECUTE ON FUNCTION board_referenced_keys(TEXT)    TO anon;
GRANT EXECUTE ON FUNCTION push_prune(TEXT, TEXT[])       TO anon;


-- =====================================================================
--  컬럼 권한 — 게시글 비밀번호 해시를 클라이언트에게 주지 않는다
--  ⚠️ 반드시 테이블 정의 뒤(파일 최하단)에서 실행할 것.
-- =====================================================================
-- 목록·상세는 지금까지 select('*') 로 읽었고, 그래서 post_password_hash(bcrypt) 가 모든 응답에
-- 함께 실려 나갔다. 비번은 6자라 오프라인 크래킹이 현실적이고, 뚫리면 남의 글을 지울 수 있다.
-- RLS 는 '행'만 거르고 '열'은 못 거른다 → 테이블 SELECT 를 회수하고 해시를 뺀 나머지 열만 다시 부여한다.
-- 이제 ?select=post_password_hash 로 직접 요청해도 권한 오류가 난다.
-- ※ 삭제 UI 는 has_password(유도 컬럼)로 분기한다. 비번 검증은 서버(delete_* RPC)에서만.
-- ※ SECURITY DEFINER 함수는 소유자 권한이라 이 회수를 우회한다 — get_post_b·get_memos 는
--    함수 본문에서 해시를 직접 비운다(위 정의 참고). service_role(관리자 Edge)은 영향 없다.
REVOKE SELECT ON review, exam_archive, class_memo, board_post, board_comment FROM anon, authenticated;

GRANT SELECT (id, course_code, professor_code, overall, workload, progress, difficulty, class_time,
              prof_comment, course_comment, fail, teamplay, presentation, like_count,
              report_count, report_reviewed_count, created_at, has_password)
    ON review TO authenticated;
GRANT SELECT (id, course_code, src_year, src_term, title, exam_type, description,
              created_at, has_password)
    ON exam_archive TO authenticated;
GRANT SELECT (id, course_code, year, term, section_no, content,
              report_count, report_reviewed_count, created_at, has_password)
    ON class_memo TO authenticated;
GRANT SELECT (id, board_id, title, content, like_count, dislike_count, comment_count,
              report_count, report_reviewed_count, view_count, hot, created_at, has_password)
    ON board_post TO authenticated;
GRANT SELECT (id, post_id, parent_id, content, created_at, has_password)
    ON board_comment TO authenticated;


-- =====================================================================
--  시간표 공유 (opt-in 공개 토글 + 팔로우 + 별칭)
--   - cadet.tt_public(위 정의): 기본 FALSE. 켠 사람만 남에게 확정시간표가 보인다.
--   - tt_follow: 내가 담아 둔 사람(팔로우) + 그 사람에 대한 내 별칭. RLS 로 내 행만.
--   - 조회는 전부 SECURITY DEFINER RPC 로만(공개 여부·본인 여부를 함수 안에서 강제).
--     시간표 데이터는 텍스트(카탈로그는 이미 클라 캐시)라 egress 부담이 작다 — 무료 티어 내.
-- =====================================================================
CREATE TABLE tt_follow (
    follower_id UUID NOT NULL REFERENCES cadet(id) ON DELETE CASCADE,   -- 나
    followee_id UUID NOT NULL REFERENCES cadet(id) ON DELETE CASCADE,   -- 내가 보는 사람
    nickname    TEXT CHECK (nickname IS NULL OR char_length(nickname) <= 20),
    sort_order  INTEGER,                                                -- 갤러리 표시 순서(사용자 지정)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (follower_id, followee_id),
    CHECK (follower_id <> followee_id)
);
CREATE INDEX idx_ttfollow_follower ON tt_follow(follower_id);

ALTER TABLE tt_follow ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_follow ON tt_follow FOR ALL TO authenticated
    USING (follower_id = auth.uid()) WITH CHECK (follower_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON tt_follow TO authenticated;

-- 내 공개 토글 on/off (본인 행만)
CREATE OR REPLACE FUNCTION set_tt_public(p_on BOOLEAN) RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    UPDATE cadet SET tt_public = COALESCE(p_on, FALSE) WHERE id = auth.uid()
    RETURNING tt_public;
$$;
REVOKE ALL ON FUNCTION set_tt_public(BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_tt_public(BOOLEAN) TO authenticated;

-- 아이디 검색(본인 제외). 비공개 생도도 검색·추가 가능(공개 여부는 public 로 반환) —
-- 지금 추가해 두면 그 사람이 나중에 공개했을 때 갤러리에 저절로 뜬다(유연 대응). 공개자 먼저.
-- following = 이미 내가 팔로우했는지.
CREATE OR REPLACE FUNCTION search_shared_users(p_q TEXT)
RETURNS TABLE(id UUID, username TEXT, public BOOLEAN, following BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT c.id, c.username, c.tt_public,
           EXISTS(SELECT 1 FROM tt_follow f WHERE f.follower_id = auth.uid() AND f.followee_id = c.id)
    FROM cadet c
    WHERE c.id <> auth.uid()
      AND c.username ILIKE '%' || COALESCE(p_q, '') || '%'
    ORDER BY c.tt_public DESC, c.username
    LIMIT 20;
$$;
REVOKE ALL ON FUNCTION search_shared_users(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION search_shared_users(TEXT) TO authenticated;

-- 내가 팔로우한 사람들의 '이번 학기' 확정시간표(공개인 경우만) — 갤러리를 한 번에(요청 1회).
-- ⚠️ 확정(is_primary)은 학기별 1개라, 반드시 semester.is_current 로 이번 학기 것만 고른다
--    (안 그러면 지난 학기 확정본이 딸려 나온다). 비공개/이번학기 확정없음 → timetable=null.
-- customs 는 TimetableGrid 형태(day/startMin/endMin)로 바로 준다. entries 는 section_id 만.
CREATE OR REPLACE FUNCTION get_shared_gallery() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE(jsonb_agg(r ORDER BY ord NULLS LAST, uname), '[]'::jsonb)
    FROM (
      SELECT f.sort_order AS ord, c.username AS uname, jsonb_build_object(
        'followee_id', c.id,
        'username', c.username,
        'nickname', f.nickname,
        'public', c.tt_public,
        'timetable', CASE WHEN tt.id IS NOT NULL THEN
          jsonb_build_object('id', tt.id, 'year', tt.year, 'term', tt.term, 'name', tt.name) END,
        'entries', COALESCE(
          (SELECT jsonb_agg(jsonb_build_object('section_id', e.section_id))
           FROM timetable_entry e WHERE tt.id IS NOT NULL AND e.timetable_id = tt.id), '[]'::jsonb),
        'customs', COALESCE(
          (SELECT jsonb_agg(jsonb_build_object('id', cc.id, 'title', cc.title, 'day', cc.day_of_week,
                 'startMin', cc.start_min, 'endMin', cc.end_min, 'room', cc.room))
           FROM custom_class cc WHERE tt.id IS NOT NULL AND cc.timetable_id = tt.id), '[]'::jsonb)
      ) AS r
      FROM tt_follow f
      JOIN cadet c ON c.id = f.followee_id
      LEFT JOIN LATERAL (
        SELECT t.id, t.year, t.term, t.name
        FROM timetable t
        JOIN semester s ON s.year = t.year AND s.term = t.term AND s.is_current
        WHERE t.cadet_id = c.id AND t.is_primary
        LIMIT 1
      ) tt ON c.tt_public
      WHERE f.follower_id = auth.uid()
    ) sub;
$$;
REVOKE ALL ON FUNCTION get_shared_gallery() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_shared_gallery() TO authenticated;

-- 친구(팔로우) 표시 순서 재부여 — 넘긴 id 배열의 위치대로 sort_order(내 행만).
CREATE OR REPLACE FUNCTION reorder_follows(p_ids UUID[]) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    UPDATE tt_follow SET sort_order = a.pos
    FROM unnest(p_ids) WITH ORDINALITY AS a(id, pos)
    WHERE tt_follow.follower_id = auth.uid() AND tt_follow.followee_id = a.id;
$$;
REVOKE ALL ON FUNCTION reorder_follows(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reorder_follows(UUID[]) TO authenticated;


-- =====================================================================
--  ★ 최종 하드닝 — 반드시 파일 최하단(모든 함수·테이블 정의 뒤)에 유지할 것 ★
--  Supabase 기본권한(ALTER DEFAULT PRIVILEGES)은 새 함수마다 anon+authenticated
--  양쪽에, 새 테이블마다 anon+authenticated SELECT 를 자동부여한다. 그래서 함수를
--  추가하고 이 블록을 다시 안 돌리면, 사용자 직접 호출을 막았다고 믿은 내부 함수
--  (apply_correction_row=관리자승인 우회 카탈로그변조, admin_push=관리자푸시 스푸핑,
--   purge_* 등)가 실제로는 열려 있는 드리프트가 생긴다(2026-07-22 실측·교정).
--  → 새 마이그레이션을 적용할 때마다 이 블록을 마지막에 함께 실행한다.
-- =====================================================================

-- 1) 함수: PUBLIC·anon 전면 회수 후, 비회원이 정당하게 쓰는 4종만 재부여.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_shared_post(UUID, BOOLEAN) TO anon;
GRANT EXECUTE ON FUNCTION share_image_ok(UUID, TEXT)     TO anon;
GRANT EXECUTE ON FUNCTION board_referenced_keys(TEXT)    TO anon;
GRANT EXECUTE ON FUNCTION push_prune(TEXT, TEXT[])       TO anon;

-- 2) 함수: authenticated 자동부여분 회수 — 프론트가 실제 .rpc() 로 부르는 함수 +
--    RLS 헬퍼(board_enabled) 만 남기고(allow 목록), 나머지 내부/트리거/크론 함수 회수.
--    (트리거 함수는 EXECUTE 권한과 무관하게 발화하고, SECURITY DEFINER 내부호출은
--     소유자 권한으로 도므로 이 회수는 프론트 기능에 영향 없음.)
--    ※ 프론트에 새 .rpc() 함수를 추가하면 이 allow 목록에 함께 넣을 것.
DO $$
DECLARE
  r RECORD;
  allow TEXT[] := ARRAY[
    'submit_correction','is_admin','get_review_min_days','geo_verify','get_boot_info',
    'in_primary_timetable','timetable_held_days','create_review','delete_review','like_review',
    'report_review','create_exam','delete_exam','create_memo','get_memos','delete_memo',
    'report_memo','board_enabled','create_board','create_post','get_post_b','board_react',
    'create_comment_b','delete_post','delete_comment_b','create_share','get_shared_post',
    'push_subscribe','push_unsubscribe','push_set_hot','push_watch','push_unwatch',
    'admin_push_subscribe','admin_push_unsubscribe','set_tt_public','search_shared_users',
    'get_shared_gallery','reorder_follows'
  ];
BEGIN
  FOR r IN
    SELECT DISTINCT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN aclexplode(p.proacl) a ON true
    JOIN pg_roles ro ON ro.oid = a.grantee
    WHERE n.nspname = 'public' AND a.privilege_type = 'EXECUTE'
      AND ro.rolname = 'authenticated' AND p.proname <> ALL(allow)
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', r.sig);
  END LOOP;
END $$;

-- 3) 테이블: RPC/service_role 로만 접근하는 내부 테이블(RLS 정책 없음)의 잔여 SELECT 회수.
--    현재도 RLS 로 전 행 차단되나, 실수로 느슨한 정책이 붙어도 새지 않도록 이중 잠금.
REVOKE SELECT ON deleted_content, push_subscription, push_config, post_watch,
                 admin_push_subscription, review_report, memo_report,
                 board_share, correction, board_event, app_setting
    FROM anon, authenticated;


-- =====================================================================
--  실행 후 할 일
--   1) 테이블·컬럼 주석 적용:  db/comments.sql Run (관리자 대시보드 가독성, 데이터 무영향).
--   2) 관리자 지정:  UPDATE cadet SET is_admin = TRUE WHERE username = '<내아이디>';
--   3) 카탈로그(교수·과목·분반) 입력: 관리자 화면에서 등록.
--   4) 운영 전 app_setting 좌표·반경·가입코드(signup_code)를 실제 값으로 교체.
--   5) Auth > Email 공급자 활성화, Edge Functions(signup·admin-action·delete-account·sync-professors) 배포.
-- =====================================================================
-- 끝.
