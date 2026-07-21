-- =====================================================================
--  애타 (anyTime) — 테이블·컬럼 한글 주석
--  목적: Supabase 대시보드(Table Editor / Database)에서 관리자가 각 테이블·컬럼의
--        의미를 눈으로 바로 파악하도록 모든 객체에 설명(COMMENT)을 부여한다.
--  성격: COMMENT 만 설정 → 데이터·구조 무영향, 몇 번을 실행해도 안전(재실행 OK).
--  실행: Supabase SQL Editor 에 통째로 Run (라이브에도 안전).
--  ⚠️ 이 파일은 db/schema.sql 의 테이블 정의와 짝을 이룬다. 스키마가 바뀌면 함께 갱신.
-- =====================================================================

-- ── 1. 회원·인증 ─────────────────────────────────────────────────────
COMMENT ON TABLE  cadet                 IS '생도(회원). 프로필·누적작성수·관리자여부. id = auth.uid(). 관리자도 생도(is_admin 플래그).';
COMMENT ON COLUMN cadet.id              IS '생도 식별자(PK) = Supabase Auth 사용자 UUID(auth.users.id).';
COMMENT ON COLUMN cadet.username        IS '아이디(로그인용, 고유). 합성이메일 <username>@anytime.app 로 인증.';
COMMENT ON COLUMN cadet.post_count      IS '누적 작성수(강의평·메모·족보·게시판 글/댓글 작성 +1, 삭제 -1). 레벨/뱃지 산출 근거.';
COMMENT ON COLUMN cadet.is_admin        IS '관리자 여부. TRUE 면 관리자 화면·기능 노출. 변경은 service_role 만.';
COMMENT ON COLUMN cadet.geo_verified_at IS '마지막 지오펜싱(위치) 인증 시각. 재인증 만료 판정에 사용.';
COMMENT ON COLUMN cadet.created_at      IS '가입 시각.';

-- ── 2. 기준 정보 (교수·학기·과목·교시) ───────────────────────────────
COMMENT ON TABLE  professor            IS '교수. 강의평·분반이 참조하는 기준 정보.';
COMMENT ON COLUMN professor.code       IS '교수코드(PK, 자동배정 P######).';
COMMENT ON COLUMN professor.name       IS '성명.';
COMMENT ON COLUMN professor.department IS '소속 학과.';
COMMENT ON COLUMN professor.office     IS '연구실 위치(공사 홈페이지 교수소개 크롤로 채움, sync-professors).';

COMMENT ON TABLE  semester             IS '학기. (연도, 학기구분) 조합이 PK. 카탈로그·시간표의 시간축.';
COMMENT ON COLUMN semester.year        IS '연도(예: 2026).';
COMMENT ON COLUMN semester.term        IS '학기구분(1=1학기, 2=2학기).';
COMMENT ON COLUMN semester.is_current  IS '현재 학기 여부. 메모 휘발(비현재 학기 메모 정리) 판정에 사용.';

COMMENT ON TABLE  course               IS '과목. 강의평·족보·분반이 참조.';
COMMENT ON COLUMN course.code          IS '과목코드(PK, 자동배정 C######).';
COMMENT ON COLUMN course.name          IS '과목명.';
COMMENT ON COLUMN course.department    IS '개설 학과.';

COMMENT ON TABLE  period               IS '교시. 편람(생도 일과시간표) 기준 1~8교시. 시간표 격자의 세로축.';
COMMENT ON COLUMN period.no            IS '교시번호(PK, 1~8).';
COMMENT ON COLUMN period.start_time    IS '해당 교시 시작 시각.';
COMMENT ON COLUMN period.end_time      IS '해당 교시 종료 시각.';

COMMENT ON TABLE  common_block              IS '전 생도 공통 비수업 시간(생도대시간·군사훈련·자율선택형교과 등). 그 학기에 어떤 분반도 열리지 않는 요일×교시 — 시각은 카탈로그에서 자동 유도되고, 이 표는 거기에 이름을 붙인다(관리자가 편람 일괄등록 때). 시간표 마법사가 이 시간을 ''빈 시간(공강교시)''으로 세지 않는 근거.';
COMMENT ON COLUMN common_block.year         IS '연도(semester 참조).';
COMMENT ON COLUMN common_block.term         IS '학기구분(semester 참조).';
COMMENT ON COLUMN common_block.day_of_week  IS '요일(1=월 … 5=금 … 7=일).';
COMMENT ON COLUMN common_block.start_period IS '시작 교시(period.no 참조).';
COMMENT ON COLUMN common_block.end_period   IS '종료 교시(period.no 참조). 연속 교시면 start<end.';
COMMENT ON COLUMN common_block.label        IS '이름(예: 생도대시간, 군사훈련, 자율선택형교과). 20자 이내.';

-- ── 3. 분반·강의시간 ─────────────────────────────────────────────────
COMMENT ON TABLE  section                IS '분반(개설 강의). 과목×학기×분반번호. PK=(course_code,year,term,section_no).';
COMMENT ON COLUMN section.course_code    IS '과목코드(course.code 참조).';
COMMENT ON COLUMN section.year           IS '개설 연도.';
COMMENT ON COLUMN section.term           IS '개설 학기구분(1/2).';
COMMENT ON COLUMN section.section_no     IS '분반번호(같은 과목·학기 내 구분).';
COMMENT ON COLUMN section.professor_code IS '담당 교수코드(professor.code 참조, 교수 삭제 시 NULL).';
COMMENT ON COLUMN section.id             IS '대체키(surrogate). timetable_entry 가 분반을 단일 컬럼으로 참조하기 위한 것 — 분반키 4컬럼을 entry 에 복제하면 timetable_id → year,term 함수종속으로 BCNF 가 깨진다.';

COMMENT ON TABLE  section_time             IS '강의시간. 한 분반이 주중 언제 열리는지(요일·교시·강의실). 연강은 여러 교시 범위.';
COMMENT ON COLUMN section_time.day_of_week IS '요일(1=월 … 5=금 … 7=일).';
COMMENT ON COLUMN section_time.start_period IS '시작 교시(period.no 참조).';
COMMENT ON COLUMN section_time.end_period   IS '종료 교시(period.no 참조). 연강이면 start<end.';
COMMENT ON COLUMN section_time.room         IS '강의실.';

-- ── 4. 시간표 ────────────────────────────────────────────────────────
COMMENT ON TABLE  timetable             IS '시간표. 한 생도가 학기마다 여러 개(지난 학기 기록·다음 학기 미리짜기, 학기당 5개까지). 계정 종속·본인만(RLS). 홈에서 전환한다.';
COMMENT ON COLUMN timetable.id          IS '시간표 id(PK).';
COMMENT ON COLUMN timetable.cadet_id    IS '생도 id(auth.uid()). 본인 행만 접근 가능.';
COMMENT ON COLUMN timetable.year        IS '연도.';
COMMENT ON COLUMN timetable.term        IS '학기구분(1/2).';
COMMENT ON COLUMN timetable.name        IS '시간표 이름(사용자 지정, 20자 이내).';
COMMENT ON COLUMN timetable.is_primary  IS '확정 여부. 학기별 1개(부분 UNIQUE). 이 시간표만 강의평·메모 자격의 근거가 된다(초안은 인정 안 함).';
COMMENT ON COLUMN timetable.created_at  IS '시간표 생성 시각.';

COMMENT ON TABLE  timetable_entry              IS '시간표에 담긴 분반(약한 개체). 분반은 대체키 section.id 로 참조. 같은 시간표 내 요일·교시 겹침 금지(트리거).';
COMMENT ON COLUMN timetable_entry.timetable_id IS '시간표 id(timetable.id 참조).';
COMMENT ON COLUMN timetable_entry.section_id   IS '분반 대체키(section.id 참조). 분반의 학기는 시간표의 학기와 같아야 한다(트리거).';
COMMENT ON COLUMN timetable_entry.created_at   IS '등록 시각. 강의평 작성 자격(확정시간표에 N일 이상 보유) 계산 기준.';

COMMENT ON TABLE  custom_class              IS '직접 추가 시간표 항목(DB에 없는 강의). 시간표 종속·본인만(RLS). 분(min) 단위 시각.';
COMMENT ON COLUMN custom_class.timetable_id IS '시간표 id(timetable.id 참조). 시간표 삭제 시 함께 삭제.';
COMMENT ON COLUMN custom_class.title        IS '사용자가 입력한 일정 제목.';
COMMENT ON COLUMN custom_class.day_of_week  IS '요일(1=월 … 7=일).';
COMMENT ON COLUMN custom_class.start_min    IS '시작 시각(자정 기준 분, 0~1439).';
COMMENT ON COLUMN custom_class.end_min      IS '종료 시각(자정 기준 분, 1~1440). start<end.';
COMMENT ON COLUMN custom_class.room         IS '장소(선택).';

-- ── 5. 강의평 (익명) ─────────────────────────────────────────────────
COMMENT ON TABLE  review                    IS '강의평(익명·다건). 작성자 컬럼 없음. 수정·삭제는 게시글 비밀번호. 신고 누적 시 자동삭제.';
COMMENT ON COLUMN review.course_code        IS '대상 과목.';
COMMENT ON COLUMN review.professor_code     IS '대상 교수(선택).';
COMMENT ON COLUMN review.overall            IS '총별점(1~5).';
COMMENT ON COLUMN review.workload           IS '과제량(1~5).';
COMMENT ON COLUMN review.progress           IS '수업진도(1~5).';
COMMENT ON COLUMN review.difficulty         IS '수업난이도(1~5).';
COMMENT ON COLUMN review.class_time         IS '수업시간 만족도(1~5).';
COMMENT ON COLUMN review.prof_comment       IS '교수평(자유서술).';
COMMENT ON COLUMN review.course_comment     IS '강의평 본문(자유서술).';
COMMENT ON COLUMN review.fail               IS '과락 여부. 과락률 뷰 산출에 사용.';
COMMENT ON COLUMN review.teamplay           IS '팀플 여부.';
COMMENT ON COLUMN review.presentation       IS '발표 여부.';
COMMENT ON COLUMN review.like_count         IS '공감수(중복 제한 없음).';
COMMENT ON COLUMN review.report_count       IS '신고 누적수. 누적 30건 또는 15분 내 10건 → 자동삭제.';
COMMENT ON COLUMN review.report_reviewed_count IS '관리자가 검열 신고탭에서 확인처리한 시점의 신고수. report_count 가 이 값을 초과할 때만(=새 신고) 목록에 노출.';
COMMENT ON COLUMN review.post_password_hash IS '게시글 비밀번호 해시(bcrypt). 삭제 인증용. NULL=비번없음(누구나 삭제). 작성자 식별 불가.';

COMMENT ON TABLE  review_report           IS '강의평 신고 이벤트(익명·횟수만). 신고자 원본 ID 미저장. 자동삭제 판정용.';
COMMENT ON COLUMN review_report.review_id IS '신고 대상 강의평.';
COMMENT ON COLUMN review_report.reporter_hash IS '신고자 해시 = actor_hash(''review'', review_id) — 대상별 솔티드 SHA-256. 신고자 원본 ID 를 저장하지 않아 "이 사람이 신고한 글 목록"을 뽑을 수 없다. (review_id, reporter_hash) UNIQUE 로 1인 반복신고를 막는다.';

-- ── 6. 족보 (익명, 파일은 R2) ────────────────────────────────────────
COMMENT ON TABLE  exam_archive                  IS '족보(익명). 파일 실체는 Cloudflare R2, 첨부 메타데이터는 exam_file 릴레이션. 게시글 비번으로 삭제.';
COMMENT ON COLUMN exam_archive.course_code      IS '대상 과목.';
COMMENT ON COLUMN exam_archive.src_year         IS '출처 연도(그 자료가 실제 시험 본 연도).';
COMMENT ON COLUMN exam_archive.src_term         IS '출처 학기구분.';
COMMENT ON COLUMN exam_archive.title            IS '제목.';
COMMENT ON COLUMN exam_archive.exam_type        IS '시험구분(중간/기말/퀴즈 등).';
COMMENT ON COLUMN exam_archive.description      IS '설명.';
COMMENT ON COLUMN exam_archive.post_password_hash IS '게시글 비밀번호 해시(bcrypt). 삭제 인증용. NULL=비번없음(누구나 삭제).';

COMMENT ON TABLE  exam_file            IS '족보 첨부파일(약한 개체 — 족보에 존재 종속, 부분키 seq). 구 files JSONB·대표파일 컬럼의 다중값 속성을 정규화(1NF)한 릴레이션.';
COMMENT ON COLUMN exam_file.exam_id    IS '소속 족보(exam_archive.id). 족보 삭제 시 CASCADE.';
COMMENT ON COLUMN exam_file.seq        IS '첨부 순번(1부터, 부분키).';
COMMENT ON COLUMN exam_file.object_key IS 'R2 객체 key(고유 — 후보키). 다운로드는 /api/exam-download 가 이 key 로 중계.';
COMMENT ON COLUMN exam_file.file_name  IS '파일명(목록·다운로드 표시용).';
COMMENT ON COLUMN exam_file.file_size  IS '파일 크기(byte).';
COMMENT ON COLUMN exam_file.mime_type  IS 'MIME 타입.';

-- ── 7. 강의 메모 (분반 종속·휘발성, 익명) ────────────────────────────
COMMENT ON TABLE  class_memo                  IS '강의 메모(분반 전용·휘발성·익명). 확정시간표 등록 생도만 열람·작성. 비현재 학기 정리.';
COMMENT ON COLUMN class_memo.content          IS '메모 내용.';
COMMENT ON COLUMN class_memo.report_count     IS '신고 누적수. 누적 30건 또는 15분 10건 → 자동삭제.';
COMMENT ON COLUMN class_memo.report_reviewed_count IS '관리자 확인처리 시점 신고수. report_count 초과분(=새 신고)만 신고탭 노출.';
COMMENT ON COLUMN class_memo.post_password_hash IS '게시글 비밀번호 해시(bcrypt). 삭제 인증용. NULL=비번없음(누구나 삭제).';

COMMENT ON TABLE  memo_report         IS '강의메모 신고 이벤트(익명·횟수만). 신고자 원본 ID 미저장. 자동삭제 판정용.';
COMMENT ON COLUMN memo_report.memo_id IS '신고 대상 메모.';
COMMENT ON COLUMN memo_report.reporter_hash IS '신고자 해시 = actor_hash(''class_memo'', memo_id). review_report.reporter_hash 와 동일한 취지(익명 유지 + 1인 반복신고 차단).';

-- ── 8. 설정·운영 (가입게이트·차단·수정제안) ──────────────────────────
COMMENT ON TABLE  app_setting                     IS '앱 전역 설정(단일 행, id=1). 지오펜싱·가입코드·각종 기간·게시판 활성화 등. 관리자만 변경.';
COMMENT ON COLUMN app_setting.campus_lat          IS '지오펜싱 중심 위도.';
COMMENT ON COLUMN app_setting.campus_lng          IS '지오펜싱 중심 경도.';
COMMENT ON COLUMN app_setting.radius_m            IS '가입·재인증 허용 반경(m).';
COMMENT ON COLUMN app_setting.review_min_days     IS '강의평 작성 자격: 해당 강의를 확정시간표에 보유해야 하는 최소 일수(기본 30; 0=대기 없이 담는 즉시 작성 가능).';
COMMENT ON COLUMN app_setting.geo_valid_days      IS '위치 재인증 유효기간(일, 기본 90).';
COMMENT ON COLUMN app_setting.account_delete_days IS '위치 만료 후 계정·데이터 삭제까지 대기 일수(기본 90).';
COMMENT ON COLUMN app_setting.board_enabled       IS '익명게시판 전체 활성화 여부. FALSE 면 글/댓글/반응/게시판 생성 차단.';
COMMENT ON COLUMN app_setting.share_enabled       IS '게시글 공유링크 비회원 열람 허용(기본 TRUE). FALSE 면 비회원은 안내문만, 회원 링크는 계속 동작.';
COMMENT ON COLUMN app_setting.hot_threshold       IS 'HOT 승격 기준: 30분 내 좋아요/싫어요/댓글이 이 수 이상이면 HOT(기본 10). check_hot 이 읽음.';
COMMENT ON COLUMN app_setting.report_delete_count IS '신고 누적 자동삭제 기준(강의평·메모·게시글 공통, 기본 30). 누적 신고수가 이 값 이상이면 아카이브 후 삭제.';
COMMENT ON COLUMN app_setting.report_burst_count  IS '신고 급증 자동삭제 기준(15분 내, 공통, 기본 10). 15분 내 신고가 이 값 이상이면 담합 의심으로 삭제.';
COMMENT ON COLUMN app_setting.report_salt         IS '행위자 해시(actor_hash) 솔트. 서버 전용 — admin-action 의 get/set 컬럼 allowlist 에 없어 관리자 화면에도 노출되지 않는다.';
COMMENT ON COLUMN app_setting.signup_code         IS '현재 유효한 공용 가입코드(평문, 관리자 표시·변경용. 대소문자 무시 비교).';
COMMENT ON COLUMN app_setting.mod_reviewed_at     IS '모더레이션 "모두 확인 처리" 컷오프. 이 시각 이전 글은 관리자 대시보드에서 숨김(데이터는 유지).';
COMMENT ON COLUMN app_setting.professors_synced_at IS '교수 명단 마지막 동기화 시각(sync-professors Edge Function 이 반영 시 갱신).';
COMMENT ON COLUMN app_setting.catalog_version     IS '카탈로그(교수·학기·과목·교시·공통공강·분반·강의시간) 변경 일련번호. 그 7개 테이블의 문 단위 트리거(bump_catalog_version)가 +1 한다. 앱은 부팅·복귀 때 get_boot_info 로 이 값만 확인해, 달라졌을 때만 IndexedDB 카탈로그 캐시를 다시 받는다(관리자 대규모 수정의 자동 반영 + 변경 없을 때 재다운로드 0).';

COMMENT ON TABLE  notice            IS '관리자 공지사항. 게시 중(활성·만료 전) 공지를 홈 팝업으로 표시. 기본 48시간 게시, 본 사용자에게는 재표시 안 함(기기 기록). 쓰기는 admin-action(service_role)만.';
COMMENT ON COLUMN notice.title      IS '공지 제목.';
COMMENT ON COLUMN notice.content    IS '공지 본문(줄바꿈 유지 표시).';
COMMENT ON COLUMN notice.is_active  IS '활성 여부. FALSE 면 팝업에서 제외(삭제 없이 보관).';
COMMENT ON COLUMN notice.expires_at IS '게시 마감 시각(기본 작성+48시간). 지나면 팝업 제외. 재게시 시 +48시간 재설정.';
COMMENT ON COLUMN notice.created_at IS '작성 시각.';
COMMENT ON COLUMN notice.updated_at IS '마지막 수정·재게시 시각. 갱신되면 이미 본 사용자에게도 팝업 재표시.';

COMMENT ON TABLE  banned_word            IS '관리자 금지어. 작성 시 클라이언트가 내장 비속어 사전과 함께 부분 마스킹(*). 읽기는 공개(마스킹용), 추가·삭제는 admin-action(service_role)만.';
COMMENT ON COLUMN banned_word.word       IS '금지어(PK). 대소문자 무시로 매칭하며 부분 문자열도 마스킹한다.';
COMMENT ON COLUMN banned_word.created_at IS '등록 시각.';

COMMENT ON TABLE  correction            IS '정보 수정 제안(익명). 잘못된 교수/과목/분반·시간·강의실을 사용자가 신고 → 관리자 검토·반영. 작성자 미저장. 대상 키는 단순 속성으로 분해 저장(정규화)·FK 로 참조 무결성 보장.';
COMMENT ON COLUMN correction.target     IS '수정 대상 종류: professor | course | section | section_time | section_add(없는 분반 추가 제안).';
COMMENT ON COLUMN correction.professor_code IS '대상 교수 코드(target=professor 일 때만, professor FK).';
COMMENT ON COLUMN correction.course_code    IS '대상 과목 코드(target=course/section/section_time 일 때, course FK).';
COMMENT ON COLUMN correction.year           IS '대상 분반 연도(target=section/section_time 일 때, section 복합 FK).';
COMMENT ON COLUMN correction.term           IS '대상 분반 학기구분(1/2).';
COMMENT ON COLUMN correction.label      IS '사람이 읽는 대상 이름(예: "전쟁사 3분반").';
COMMENT ON COLUMN correction.section_no     IS '대상 분반 번호(section_add 는 NULL — 아직 없는 분반이라 복합 FK 미검사 대상).';
COMMENT ON COLUMN correction.field      IS '수정 항목: name | department | office | professor | room | time | section(분반 전체 추가).';
COMMENT ON COLUMN correction.suggested  IS '제안값(시간 "수3 수4 금1", 교수 "이름 (코드)"; section_add 는 정규화 JSON {no,prof,room,times}).';
COMMENT ON COLUMN correction.note       IS '제안자 설명.';
COMMENT ON COLUMN correction.status     IS '처리 상태: pending(대기) | applied(자동반영 알림 대기). 수동 반영·반려·알림확인 건은 행 삭제(미보관).';
COMMENT ON COLUMN correction.auto_applied IS '동일 제안 3건↑로 시스템이 자동반영 처리했는지(분반 항목·분반추가). 관리자 확인 시 삭제.';
COMMENT ON COLUMN correction.prev_value IS '반영 직전 값(자동반영 알림에서 ''수정 전 → 수정 후'' 비교 표시용; 대기중엔 NULL).';

-- ── 9. 익명게시판 ────────────────────────────────────────────────────
COMMENT ON TABLE  board                  IS '익명게시판(주제별). 이름 고유. 30일 무활동 시 자동 정리.';
COMMENT ON COLUMN board.name             IS '게시판 이름(고유).';
COMMENT ON COLUMN board.last_activity_at IS '마지막 활동 시각(글·댓글·반응). 비활성 게시판 정리 기준.';

COMMENT ON TABLE  board_post                    IS '게시글(익명). 작성자 컬럼 없음. 수정·삭제는 게시글 비번. 신고 누적 시 자동삭제. 90일 정리.';
COMMENT ON COLUMN board_post.board_id           IS '소속 게시판.';
COMMENT ON COLUMN board_post.title              IS '제목.';
COMMENT ON COLUMN board_post.content            IS '본문.';
COMMENT ON COLUMN board_post.post_password_hash IS '게시글 비밀번호 해시(bcrypt). 삭제 인증용. NULL=비번없음(누구나 삭제).';
COMMENT ON COLUMN board_post.like_count         IS '좋아요 수.';
COMMENT ON COLUMN board_post.dislike_count      IS '싫어요 수.';
COMMENT ON COLUMN board_post.comment_count      IS '댓글 수(대댓글 포함).';
COMMENT ON COLUMN board_post.report_count       IS '신고 누적수. 누적 30건 또는 15분 10건 → 자동삭제.';
COMMENT ON COLUMN board_post.report_reviewed_count IS '관리자 확인처리 시점 신고수. report_count 초과분(=새 신고)만 신고탭 노출.';
COMMENT ON COLUMN board_post.view_count         IS '조회수(상세 열람 수). 상세 조회 RPC(get_post_b)에 편승해 별도 요청 없이 집계, 기기당 1회.';
COMMENT ON COLUMN board_post.hot                IS 'HOT 여부. 30분 내 like/dislike/comment 합 10↑ 이면 TRUE(목록 상단 고정).';

COMMENT ON TABLE  board_post_image            IS '게시글 이미지(약한 개체 — 게시글에 존재 종속, 부분키 seq). 구 image_key/image_keys 다중값 속성을 정규화(1NF)한 릴레이션. 실체는 R2(board/ prefix).';
COMMENT ON COLUMN board_post_image.post_id    IS '소속 게시글(board_post.id). 글 삭제 시 CASCADE.';
COMMENT ON COLUMN board_post_image.seq        IS '이미지 순번(1부터, 부분키).';
COMMENT ON COLUMN board_post_image.object_key IS 'R2 객체 key(고유 — 후보키). /api/board-image 가 이 key 로 스트리밍, 고아는 스윕이 정리.';

COMMENT ON TABLE  board_share            IS '게시글 공유 링크 토큰. 글당 1개 고정, 글 삭제 시 CASCADE 소멸. RLS 정책 없음 → definer 함수 전용.';
COMMENT ON COLUMN board_share.post_id    IS '대상 게시글(PK·FK, CASCADE).';
COMMENT ON COLUMN board_share.token      IS '공유 토큰(UUID, 추측 불가). 공유 URL /s/{token}.';
COMMENT ON COLUMN board_share.created_at IS '최초 공유 시각.';

COMMENT ON TABLE  board_comment                    IS '댓글·대댓글(익명). parent_id 로 대댓글 표현. 삭제는 게시글 비번.';
COMMENT ON COLUMN board_comment.post_id            IS '소속 게시글.';
COMMENT ON COLUMN board_comment.parent_id          IS '부모 댓글(대댓글일 때). NULL 이면 최상위 댓글.';
COMMENT ON COLUMN board_comment.content            IS '댓글 내용.';
COMMENT ON COLUMN board_comment.post_password_hash IS '댓글 비밀번호 해시(bcrypt). 삭제 인증용. NULL=비번없음(누구나 삭제).';

COMMENT ON TABLE  board_event         IS '게시글 반응/신고/댓글 이벤트(익명·횟수만). HOT·자동삭제 판정의 원자료.';
COMMENT ON COLUMN board_event.actor_hash IS '행위자 해시 = actor_hash(''board_post'', post_id). like/dislike/report 에 채우고 comment 는 NULL(한 사람이 여러 댓글 가능). (post_id, kind, actor_hash) 부분 UNIQUE 로 1인 1회 — 이게 없으면 좋아요 연타로 아무 글이나 HOT 승격시켜 구독자 전원에게 푸시를 쏘거나, 신고 연타로 아무 글이나 지울 수 있다. 취소(unlike)도 이 해시로 "내 이벤트"만 정확히 지운다.';
COMMENT ON COLUMN board_event.post_id IS '대상 게시글.';
COMMENT ON COLUMN board_event.kind    IS '이벤트 종류: like | dislike | report | comment.';

COMMENT ON TABLE  board_favorite          IS '게시판 즐겨찾기. 생도별·게시판별. 계정 종속·본인만(RLS).';
COMMENT ON COLUMN board_favorite.cadet_id IS '생도 id(auth.uid()).';
COMMENT ON COLUMN board_favorite.board_id IS '즐겨찾기한 게시판.';

-- ── 웹푸시 ───────────────────────────────────────────────────────────
COMMENT ON TABLE  push_subscription            IS '웹푸시 구독(기기 단위·완전 익명 — cadet_id·타임스탬프 미보관). 클라이언트는 RPC(push_subscribe 등)로만 접근, 직접 조회 불가(RLS 전면 차단).';
COMMENT ON COLUMN push_subscription.endpoint   IS '푸시서비스(FCM/Apple/Mozilla) endpoint URL. 브라우저가 발급한 임의 값 — 사람과 연결되지 않음. 발송 404/410 시 자동 정리(push_prune).';
COMMENT ON COLUMN push_subscription.p256dh     IS '구독 페이로드 암호화용 공개키(base64url). RFC 8291 aes128gcm.';
COMMENT ON COLUMN push_subscription.auth       IS '구독 인증 시크릿(base64url).';
COMMENT ON COLUMN push_subscription.hot_alerts IS 'HOT 승격 방송 수신 여부(기기별 설정, 프로필에서 토글).';

COMMENT ON TABLE  post_watch                 IS '글 지켜보기(댓글 알림 단위). 익명 — 작성자가 아니라 "알림 원하는 기기"의 기록이며 누구나 아무 글에 걸 수 있음. 글/구독 삭제 시 CASCADE.';
COMMENT ON COLUMN post_watch.post_id         IS '지켜보는 게시글.';
COMMENT ON COLUMN post_watch.subscription_id IS '알림 받을 구독(기기).';

COMMENT ON TABLE  push_config               IS '웹푸시 발송 게이트 설정(1행). 클라이언트 접근 불가(RLS 전면 차단).';
COMMENT ON COLUMN push_config.fanout_secret IS '트리거→Pages /api/push-fanout 호출 인증 시크릿. Cloudflare PUSH_SECRET 과 동일 값. NULL 이면 발송 비활성.';

COMMENT ON TABLE  admin_push_subscription    IS '관리자 푸시 구독(cadet_id 저장 — 일반 push_subscription 의 완전 익명과 대비). 새 수정제안·신고 자동삭제·수정제안 자동반영을 관리자에게만 알림. 관리자 기기가 옵트인(검열 화면 진입)할 때만 쌓임. RLS 전면 차단(RPC 전용).';
COMMENT ON COLUMN admin_push_subscription.cadet_id IS '관리자(생도) id. is_admin 확인 후 등록(admin_push_subscribe).';
COMMENT ON COLUMN admin_push_subscription.endpoint IS '푸시서비스 endpoint URL. 발송 404/410 시 push_prune 로 함께 정리.';

-- ── 검열 아카이브 ────────────────────────────────────────────────────
COMMENT ON TABLE  deleted_content              IS '신고 누적 자동삭제된 내용의 스냅샷(오삭제 복구 안전망). 작성자 식별정보 미보관(완전 익명). 30일 뒤 자동 파기(purge_deleted_archive). 서비스롤 Edge 만 접근.';
COMMENT ON COLUMN deleted_content.type         IS '원본 종류: review | class_memo | board_post.';
COMMENT ON COLUMN deleted_content.orig_id      IS '원본 행 id. 복구 시 이 id 로 재삽입(permalink 보존).';
COMMENT ON COLUMN deleted_content.label        IS '관리자 표시용 맥락(과목코드 또는 게시판명).';
COMMENT ON COLUMN deleted_content.text         IS '내용 스냅샷(사람이 읽는 텍스트). 목록 표시용.';
COMMENT ON COLUMN deleted_content.report_count IS '삭제 시점의 신고 누적수.';
COMMENT ON COLUMN deleted_content.reason       IS '삭제 트리거: burst_10(15분 10건) | threshold_30(누적 30건). 구 기준 행: burst_3/threshold_10.';
COMMENT ON COLUMN deleted_content.snapshot     IS '전체 행 스냅샷(JSONB). restore_deleted 가 원본 테이블로 재삽입. 작성자 식별정보 없음.';
COMMENT ON COLUMN deleted_content.reviewed     IS '관리자 확인 여부. 검열>삭제됨 탭의 미확인 배지 판정용.';
COMMENT ON COLUMN deleted_content.deleted_at   IS '자동삭제·아카이브 시각. 30일 경과 시 자동 파기.';

-- ── 10. 뷰 (유도속성) ────────────────────────────────────────────────
COMMENT ON VIEW course_professor_rating IS '과목×교수 조합의 강의평 집계: 리뷰수·항목별 평균·과락률(fail_ratio). 미저장 유도속성.';
COMMENT ON VIEW professor_rating        IS '교수별 강의평 집계: 리뷰수·총평점 평균·과락률. 미저장 유도속성.';

NOTIFY pgrst, 'reload schema';
