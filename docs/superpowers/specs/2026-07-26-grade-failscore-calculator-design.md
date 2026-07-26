# 학점/과락점수계산 기능 — 설계

작성일: 2026-07-26

## 배경·목표
익명게시판이 아직 비활성(`app_setting.board_enabled=false`)인 동안 비어 있는 홈의 accent 타일
자리에 실사용 기능을 넣는다. 생도가 **학기 평점(GPA)**과 **기말 최소 필요점수(과락 방지)**를
직접 계산하는 두 계산기를 제공한다. 게시판 기능은 제거하지 않고, 활성화되면 관리자 버튼처럼
가로 한 칸(`nav-tile-wide`) 버튼으로 되살아난다.

## 1. 홈 화면 배치 (`src/pages/Home.jsx`)
- 익명게시판 **accent 타일** → **"학점·과락 계산"** 타일로 교체(`nav-tile-accent`, 🧮, 라우트 `/calc`). 항상 표시.
- 익명게시판은 `boardOn === true`일 때만 **`nav-tile-wide` 통칸 버튼**으로 렌더(💬, `/boards`). `false`면 렌더 안 함(기존 "준비중" 비활성 타일 삭제).
- 관리자 통칸 버튼은 그대로.

## 2. 페이지 (`src/pages/Calc.jsx`, lazy)
- 라우트 `/calc`(`ProtectedRoute` 안, 게이트 없음). `App.jsx`에 lazy import + Route 추가.
- `page-header` + `BackButton` + 제목. 상단 탭 2개: **학점계산기 / 과락점수계산기**. 활성탭 상태만.
- 자기 CSS `import '../styles/calc.css'`. 색은 전부 토큰(`var(--...)`), 다크모드 자동.

## 3. 학점계산기 — 서버 저장

### 3.1 테이블 `grade_entry` (`db/schema.sql` 단일원본 + 증분 마이그레이션)
```sql
CREATE TABLE grade_entry (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cadet_id    UUID     NOT NULL REFERENCES cadet(id) ON DELETE CASCADE,
    year        SMALLINT NOT NULL,
    term        SMALLINT NOT NULL,
    course_name TEXT     NOT NULL CHECK (btrim(course_name) <> '' AND char_length(course_name) <= 60),
    credit      NUMERIC(3,1) CHECK (credit IS NULL OR (credit >= 0 AND credit <= 30)),  -- NULL=미입력
    grade       TEXT CHECK (grade IS NULL OR grade IN
                  ('A+','A0','A-','B+','B0','B-','C+','C0','C-','D+','D0','D-','F')),   -- NULL=미입력
    sort_order  INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_grade_entry_cadet ON grade_entry (cadet_id, year DESC, term DESC, sort_order);
ALTER TABLE grade_entry ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_grade_entry ON grade_entry FOR ALL TO authenticated
    USING (cadet_id = auth.uid()) WITH CHECK (cadet_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON grade_entry TO authenticated;
```
- `semester(year,term)`에 FK **걸지 않음**: 과거 학기 성적은 편람 학기 목록과 무관한 개인 기록이라 카탈로그 변경에 영향받지 않아야 함.
- 비밀번호/해시 컬럼 없음 → `select('*')` 허용(no-select-star 제약 무관).
- RLS는 `own_timetable`과 동일 패턴(본인 행만).

### 3.2 `src/lib/grades.js`
- `GRADE_POINTS`: `{ 'A+':4.3,'A0':4.0,'A-':3.7,'B+':3.3,'B0':3.0,'B-':2.7,'C+':2.3,'C0':2.0,'C-':1.7,'D+':1.3,'D0':1.0,'D-':0.7,'F':0.0 }` (4.3 만점).
- `GRADE_ORDER`: 위 키 순서(셀렉트 옵션용).
- CRUD: `listGrades()`(내 전 행), `addGrade(row)`, `updateGrade(id, patch)`, `deleteGrade(id)`, `addGrades(rows[])`(시드 벌크). supabase 직접, `cadet_id`는 세션 uid.
- 순수 계산:
  - `semesterGpa(rows)` = Σ(point×credit)/Σ(credit), **credit>0 && grade≠null 행만**. 없으면 null.
  - `groupBySemester(rows)` → `[{year,term,rows,gpa,credits}]` 최신순.
  - `cumulativeGpa(rows)` = 전체 대상 행 가중평균.
  - `trend(groups)` → 추이 차트용 `[{label:'26-1', gpa}]` 오래된→최신.

### 3.3 UI (학점계산기 탭)
- **학기 선택** 드롭다운: `semesterList(catalog)` ∪ 내 grade 행의 학기(편람에 없어도). 라벨 `YY-학기`.
- 선택 학기의 과목 행 목록. 각 행: 과목명(수정) · **학점**(number, step 0.1) · **성적등급**(select, 빈값=미입력) · 삭제.
- 버튼: **"＋ 과목 추가"**(빈 행), **"시간표에서 불러오기"**(그 학기 **확정 시간표** 과목명을 행으로 시드; 이미 있는 이름은 건너뜀).
- 요약: **이 학기 평점 / 이수학점**, **누적 평점**.
- **학기별 추이**: 인라인 SVG 라인+점 차트(외부 라이브러리 없음). Y축 0~4.3, 각 학기 점, 토큰 색(`--primary`, `--text-2`). 학기 1개뿐이면 점만.
- 저장: 입력 blur/변경 시 그 행만 `updateGrade`(디바운스 불필요, 저빈도). 낙관적 로컬 상태 + 실패 시 롤백/토스트.

## 4. 과락점수계산기 — 로컬 저장

### 4.1 저장 (`localStorage`)
- 키 `anytime.failscore.<uid>`, 값 `{ warnThreshold:number, courses:[Course] }`.
- `Course = { id, name, threshold:number(기본 60), evals:[Eval] }`.
- `Eval = { key:'수시'|'중간'|'기말', ratio:number, score:number|null }` 기본 비율 30/30/40.
- 시드: 로컬 상태 없을 때 현재 학기 **확정 시간표** 과목(`buildMyTimetable`의 `mine`)으로 과목 생성. "다시 불러오기"로 병합(이름 중복 skip).

### 4.2 `src/lib/failscore.js` (순수)
계약: 반영비율은 백분율(합 100 기준). `computeCourse(course)`가 표시·정렬·경고에 필요한 값을 한 번에 반환.
```
enteredContribution = Σ(entered eval: score * ratio/100)
remaining           = max(0, threshold - enteredContribution)   // 이미 넘었으면 0
blankRatioSum       = Σ(blank eval: ratio)
// 비율대로 분배 → 모든 빈 칸의 '필요 원점수'는 동일:
neededRaw           = blankRatioSum>0 ? remaining*100/blankRatioSum : 0
per eval:
  entered → { entered:true,  display: score,                 raw: score }
  blank   → { entered:false, display: remaining*ratio/blankRatioSum,  // = 가중 기여분
                              neededRaw }
securedContribution = enteredContribution           // 정렬 키
impossible          = neededRaw > 100               // 사실상 통과 불가
warn(threshold)     = (빈 칸 존재) && neededRaw > warnThreshold
```
- **검증(스펙 예시)**: 30:30:40 전부 빈칸 → 18·18·24 / 수시100 → 100·12.9·17.1 / 이어 중간100 → 100·100·0. (구현 후 스크래치 스크립트로 수치 대조.)
- `ratioSum(course)` 검증: 100 아니면 UI 경고 칩(계산은 그대로).

### 4.3 UI (과락점수계산기 탭)
- 상단: **경고 슬라이더**(0~100, 기본 예: 80) — "필요 원점수(`neededRaw`)가 이 값을 넘는 과목을 경고표시". 값 옆에 숫자.
- 과목 카드 목록, **`securedContribution` 오름차순**(확보 적은=위험 과목 위로), 동률은 이름순.
- 카드 헤더: 과목명 · **과락기준**(number, 기본 60, 과목별 수정) · 삭제. `warn`이면 카드에 `is-warn` 클래스(경고 토큰 테두리/배경).
- 3칸(수시/중간/기말): 각 칸 = **점수 input** + **비율 input**.
  - 입력된 칸: 원점수 그대로, **그레이아웃 글씨**(`is-entered`).
  - 빈 칸: **필요 기여분(`display`)** 강조 표시. 탭하면 그 칸 점수를 `neededRaw`로 채움(→ 입력칸이 되고 나머지 재계산).
  - `impossible`이면 그 값 자리에 "불가"(경고색).
- 하단: **＋ 과목 추가**(빈 카드), **시간표에서 다시 불러오기**.
- 모든 변경은 로컬 상태 → `localStorage` 저장(요청 0, egress 0).

## 5. 파일 목록
- 신규: `src/pages/Calc.jsx`, `src/lib/grades.js`, `src/lib/failscore.js`, `src/styles/calc.css`
- 수정: `src/pages/Home.jsx`, `src/App.jsx`, `db/schema.sql`
- 마이그레이션: `db/2026-07-26-grade-entry.sql`(증분 — 라이브 전체 재실행 금지)

## 6. 배포
1. 프론트 완성·`npm run build` 통과 확인.
2. 라이브 Supabase에 **증분 SQL만** 적용(`grade_entry` 추가는 순수 additive — cadet/users 무영향). 적용은 `supabase db query --linked --file db/2026-07-26-grade-entry.sql`.
3. 즉시 프론트 배포(`npm run deploy` 또는 git push→Pages). 스키마 적용~배포 시차 최소화.
- 과락계산기는 서버 의존 없음(로컬). 학점계산기는 `grade_entry` 없으면 조회 실패 → 반드시 2→3 순서.

## 7. 되돌리기 쉬운 판단(사용자 검토용)
- 과락기준 = **과목별**(전역 아님).
- 경고 슬라이더 비교값 = **필요 원점수(neededRaw)**(가중 기여분 아님).
- 추천값 탭 = 그 칸을 **원점수(neededRaw)로 채움**.
- 과목 정렬 = **확보 기여분 오름차순**.
- 학점계산기 `credit` 미입력 허용(시드 직후 빈칸). GPA는 학점·등급 둘 다 있는 행만 집계.
