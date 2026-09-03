# 학기 생명주기 · 학생 방향 잡기 · 성적 학기 분리 — 설계

작성: 2026-09-03

## 배경 — 관찰된 현상

새 학기(26-2)가 시작됐는데 사용자들이 지난 학기(26-1) 강의를 검색하고 "시간표가
안 맞다"고 리포트한다. 파고 보니 한 원인이 아니라 네 갈래다.

| # | 현상 | 코드상 원인 |
|---|---|---|
| 1 | 복귀 사용자가 26-1 시간표에 갇힘 | `pickTimetable`이 기기 localStorage 포인터(26-1)를 최우선 존중. 신규 가입자만 현재 학기 시간표가 자동 생성되고([Home.jsx:203](../../../src/pages/Home.jsx#L203)), 복귀자를 새 학기로 옮기는 장치가 없다 ([timetable.js:58-64](../../../src/lib/timetable.js#L58-L64)) |
| 2 | 강의 검색이 지난 학기를 보여줌 | 검색 대상 학기 = "담을 시간표의 학기". 26-1 시간표가 선택돼 있으면 26-1 분반만 조립된다 ([CourseSearch.jsx:39-43](../../../src/pages/CourseSearch.jsx#L39-L43)) |
| 3 | 편람 입력·조정 중인 학기를 생도가 확정본으로 오해 | 관리자가 학기를 추가하면(편람 입력하려면 학기부터 있어야 함) 즉시 `semesterList`에 노출된다. "아직 준비 중" 상태가 없다 |
| 4 | 성적 입력이 편람 학기에만 묶임 + 등록된 모든 학기가 나열됨 | Calc 학기 후보 = `semesterList(catalog) ∪ 내 성적행`. 스키마 주석은 "성적은 편람 학기 목록과 무관한 개인 기록"이라는데([schema.sql:312-313](../../../db/schema.sql#L312)) UI가 이를 어긴다 ([Calc.jsx:62-67](../../../src/pages/Calc.jsx#L62-L67)) |

부작용: 26-2 확정 시간표가 없으니 다음 수업 알림·오늘 브리핑도 조용히 꺼진다
(`list.find(t => t.year===sem.year && t.term===sem.term && t.isPrimary)`가 빈 값 —
[nextClass.js:128](../../../src/lib/nextClass.js#L128)).

## 핵심 통찰

"지난 학기에 갇힘"(수동적·기본값)과 "다음 학기 미리짜기 / 지난 학기 열람"
(능동적·사용자가 직접 전환)은 구분 가능하다. 해법은 **학기 고정**이 아니라
**기본 선택을 똑똑하게 + 뒤처졌을 때만 앞으로 넛지**다.

수강신청은 이전 학기 말에 열리므로 다음 학기 시간표를 미리 짤 수 있어야 하고,
편람을 입력하려면 학기가 먼저 등록돼 있어야 한다. 그래서 학기 하나는 여러 단계를
거친다: `없음 → 편람 입력중(숨김) → 수강계획 가능(공개) → 현재(학기 시작) → 지난 학기`.

---

## Ⅰ. 학기 생명주기 (숨김 / 수강계획 / 현재)

### 데이터 모델

`semesters/{year}_{term}` 문서에 불리언 하나 추가:

```
{ year, term, isCurrent: bool, hidden: bool }
```

- `hidden`: 관리자가 학기를 추가하면 **기본 `true`**. 생도 화면 어디에도 안 나온다.
- `isCurrent`: 지금과 동일(항상 최대 1개). 현재 학기는 절대 `hidden`일 수 없다(관리자 액션이 강제).
- 기존 문서에 `hidden` 필드가 없으면 `false`로 취급(모두 이미 사용 중) — 백필 불필요, 새 문서만 명시적으로 `hidden: true`.

세 학생-대면 상태는 **현재 학기 대비 위치로 파생**한다. 별도 enum 없음:

| 파생 상태 | 조건 | 생도 화면 |
|---|---|---|
| 숨김 | `hidden === true` | 안 보임 |
| 수강계획 | `!hidden` & 현재보다 미래 | 짤 수 있음, 홈 기본값 아님, "확정 전" 경고 |
| 현재 | `isCurrent === true` | 홈 기본값, 모든 기능의 대상 |
| 지난 | `!hidden` & 현재보다 과거 | 스위처에서 전환하면 열람 |

### `currentSemester()` — 날짜 인식 파생 (클라이언트가 진실의 원천)

`isCurrent` 플래그는 **하한선**일 뿐이고, 날짜가 그를 앞지르면 날짜가 이긴다.
단 카탈로그에 데이터가 있는 학기까지만(데이터 없는 학기로 점프 금지).

```js
// src/lib/cache.js
function semesterForDate(d = new Date()) {
  const m = d.getMonth() + 1;             // 경계: 1학기=3월, 2학기=8월 시작
  if (m >= 3 && m <= 7) return { year: d.getFullYear(), term: 1 };
  if (m >= 8)           return { year: d.getFullYear(), term: 2 };
  return { year: d.getFullYear() - 1, term: 2 };   // 1~2월 = 지난 2학기(겨울방학)
}

export function currentSemester(catalog, now = new Date()) {
  const visible = (catalog.semesters ?? []).filter((s) => !s.hidden);
  if (!visible.length) return null;
  const key = (s) => s.year * 10 + s.term;
  const flagged = visible.find((s) => s.isCurrent) ?? null;
  const impliedKey = (() => { const i = semesterForDate(now); return i.year * 10 + i.term; })();
  const dated = visible.find((s) => key(s) === impliedKey) ?? null;   // 카탈로그에 있을 때만
  const byKeyDesc = [...visible].sort((a, b) => key(b) - key(a));
  // flagged 와 dated 중 더 최근 것, 둘 다 없으면 가장 최근 비숨김 학기
  return [flagged, dated].filter(Boolean).sort((a, b) => key(b) - key(a))[0] ?? byKeyDesc[0];
}
```

이 파생만으로 이번 사건의 클라이언트 UI(홈·강의검색·마법사·빈강의실·계산기 시드)는
즉시 옳은 학기를 가리킨다. **백엔드 변경 없이도 학생 방향 잡기(Ⅱ)가 성립한다.**

### 백엔드 — `isCurrent` 플래그 따라잡기 (2차)

`where('isCurrent','==',true)`를 쓰는 백엔드 3곳(`getSharedGallery`
[timetable.js:438](../../../firebase/functions/src/timetable.js#L438), `classMemo`
[classMemo.js:188](../../../firebase/functions/src/classMemo.js#L188), 그리고
`nextClassNotify`)의 결과 정확도를 위해 플래그도 결국 넘어가야 한다.

- **날짜 백스톱**: 기존 매분 함수 `nextClassNotify` 안에 판정 1회 추가(새 Cloud Scheduler 잡 없음 — 오늘 브리핑 설계와 같은 원칙). 가장 최근 **비숨김** 학기의 시작일(1학기 3/1, 2학기 8/1)이 지났고 그게 아직 `isCurrent`가 아니면, 그 문서로 `isCurrent`를 옮기고 이전 것을 내린다. 실제 쓰기는 1년에 최대 두 번. **숨김 학기는 절대 승격하지 않는다**(관리자가 편람을 아직 안 끝낸 경우 보호).
- 가드: `set_semester`(현재 학기 지정) 액션은 대상 문서의 `hidden`을 `false`로 강제.

### 관리자 UI ([Admin.jsx:1020-1041](../../../src/pages/Admin.jsx#L1020-L1041) 학기 섹션)

학기 태그마다 파생 상태를 라벨로(`숨김`/`수강계획`/`현재`/`지난`) 표시하고,
액션 버튼 3개:

| 버튼 | 동작 | 조건 |
|---|---|---|
| `＋ 학기 추가` | 새 `semesters` 문서, `hidden: true` | 항상 |
| `수강계획으로 공개` | `hidden: false` | `hidden`이고 아직 미공개일 때 |
| `현재 학기로 설정` | 기존 `set_semester` 액션 + `hidden: false` 강제 | 현재가 아닐 때 |

`catalogActions.js`의 `ensureSemester`([catalogActions.js:52-61](../../../firebase/functions/src/admin/catalogActions.js#L52))가
문서를 만들 때 `hidden: true` 추가. 이 함수는 편람 수정 제안·분반 추가에서도 불리므로
(새 학기가 그렇게 생겨도) 숨김 시작이 맞다. 공개는 항상 명시적 액션.

### 마이그레이션

- `isCurrent: true`인 26-2 → 그대로 (planning으로 내리지 않음 — 확정).
- 나머지 기존 학기 → `hidden` 없음 = `false` 취급, 백필 불필요.
- 배포 즉시 26-1 시간표에 갇힌 사용자는 홈 배너(Ⅱ)로 26-2로 유도된다.

---

## Ⅱ. 학생 방향 잡기

### 1. `pickTimetable` 규칙 변경 — 지난 학기 포인터는 유예 창 안에서만 존중

기기 localStorage 포인터가 **현재 이상** 학기를 가리키면 지금처럼 존중한다.
**지난 학기**를 가리키면, 그 선택이 스위처에서의 **명시적 전환**이었고 아직
14일이 안 지났을 때만 존중하고, 그 외에는 현재 학기 확정본으로 되돌린다.

**두 종류의 포인터 쓰기를 구분한다:**
- `writeSelectedId(id)` — 기존. 수동 복원 이펙트([Home.jsx:226](../../../src/pages/Home.jsx#L226))에서도 불림. 타임스탬프 안 남김.
- `selectTimetable(id)` — 신규. 스위처의 `handleSelect`([Home.jsx:292](../../../src/pages/Home.jsx#L292))·`changeTarget`(CourseSearch)에서만. `anytime:selectedTimetableAt` 에 `Date.now()` 기록.

```js
// src/lib/timetable.js
const SELECTED_AT_KEY = 'anytime:selectedTimetableAt';
const PAST_GRACE_MS = 14 * 24 * 60 * 60 * 1000;   // add/drop 참고 창

export function selectTimetable(id) {              // 명시적 전환 전용
  writeSelectedId(id);
  try { localStorage.setItem(SELECTED_AT_KEY, String(Date.now())); } catch { /* ignore */ }
}
export function readSelectedAt() {
  try { return Number(localStorage.getItem(SELECTED_AT_KEY)) || 0; } catch { return 0; }
}

export function pickTimetable(list, current, preferredId = null, preferredAt = 0) {
  if (!list?.length) return null;
  const key = (s) => s.year * 10 + s.term;
  const curKey = current ? key(current) : 0;
  const byId = preferredId && list.find((t) => t.id === preferredId);
  if (byId) {
    const past = curKey && key(byId) < curKey;
    if (!past) return byId;                                       // 현재·미래(수강계획): 그대로
    if (Date.now() - preferredAt < PAST_GRACE_MS) return byId;    // 최근 명시적 전환 → 유예
  }
  const cur = current &&
    list.find((t) => t.year === current.year && t.term === current.term && t.isPrimary);
  return cur ?? list.find((t) => t.isPrimary) ?? list[0];         // 없으면 최신 확정본(+배너)
}
```

호출부: `pickTimetable(list, currentSemester(catalog), readSelectedId(), readSelectedAt())`.

**의미 / add/drop 처리**:
- 지난 학기 시간표를 **스위처에서 직접 골랐다면** 14일간 재시작해도 유지된다 —
  add/drop 기간에 지난 학기를 참고용으로 띄워 두는 흐름을 덮는다.
- 그 사이 26-2로 한 번이라도 명시적 전환하면 타임스탬프가 26-2를 가리키므로
  정상 복귀. 유예 창은 "마지막으로 고른 게 지난 학기이고 이후 아무것도 안 골랐다"는
  좁은 경우에만 지난 학기를 붙든다.
- **갇힌 사용자**(작년 봄 26-1을 만들 때가 마지막 명시적 선택)는 타임스탬프가
  수개월 전 → 유예 만료 → 26-2로 스냅. 갇힘 리포트가 풀린다.
- 미래(수강계획) 학기 초안은 유예와 무관하게 항상 고정(다음 학기 미리짜기 보존).
- 홈 배너(Ⅱ.2)는 유예 여부와 무관하게 `selected` 학기 < 현재면 항상 뜬다 —
  유예 창 안에서 26-1을 봐도 "지금은 26-2학기입니다"는 계속 보인다.

### 2. 홈 상단 배너 ([Home.jsx](../../../src/pages/Home.jsx) 시간표 카드 위)

`selected && current && (selected.year·term) < current` 일 때:

```
📅 지금은 26-2학기입니다.
   [🪄 마법사로 26-2 짜기]   [빈 26-2 시간표]
```

- `빈 26-2 시간표`: `createTimetable({year, term: 현재})` → 생성본으로 전환.
- `🪄 마법사`: `seedDraft(uid, { semKey: '26-2', picked: [] })` 후 `/wizard`.
- 이미 26-2 확정본이 있는데 수동으로 26-1을 보고 있는 경우 → 배너 문구
  "26-1은 지난 학기입니다 · [26-2 시간표로]" (전환만).
- `conflicts` 배너와 같은 자리·톤(`tt-conflict-warn` 스타일 재사용).

### 3. 수강계획 학기 넛지

미래에 비숨김(수강계획) 학기가 있고 내 시간표가 하나도 없으면, 더 약한 힌트를
`TimetableSwitcher` 패널 안 또는 홈 하단에:

```
📖 26-2 수강 계획을 시작할 수 있어요.  [26-2 시간표 만들기]
```

지난 학기 배너(2)보다 약하게 — 상단 배너로 올리지 않는다(지금 당장의 문제가 아님).

### 4. 강의 검색 ([CourseSearch.jsx](../../../src/pages/CourseSearch.jsx))

- 검색 결과 위에 **검색 중인 학기를 항상 명시**: "26-1학기 강의".
- 그 학기가 현재보다 과거면: "지난 학기(26-1) 강의를 보고 있습니다 · [26-2로 전환]"
  (전환 = 현재 학기 확정본을 `담을 시간표`로 선택, 없으면 홈 배너로 안내).
- 수강계획 학기면: "확정 전 — 편람 조정 중이라 시간·강의실이 바뀔 수 있어요."
- `담을 시간표` 드롭다운([CourseSearch.jsx:210-223](../../../src/pages/CourseSearch.jsx#L210-L223))의
  옵션에 숨김 학기 시간표는 원래 없음(생성 자체가 막힘). 변화 없음.
- `loadTimetables`의 `pickTimetable(list, null, readSelectedId())`
  ([CourseSearch.jsx:66](../../../src/pages/CourseSearch.jsx#L66))를
  `pickTimetable(list, currentSemester(catalog), readSelectedId(), readSelectedAt())`로
  — Ⅱ.1 규칙이 여기서도 적용돼 지난 학기 시간표가 기본 대상이 되지 않게.
  (catalog 로드 이후 실행되도록 순서 조정 필요.)
- `changeTarget`([CourseSearch.jsx:108-111](../../../src/pages/CourseSearch.jsx#L108))의
  `writeSelectedId` → `selectTimetable`(명시적 전환이므로 타임스탬프 기록).

### 5. 마법사 ([Wizard.jsx:721-730](../../../src/pages/Wizard.jsx#L721-L730))

- 학기 드롭다운(`semesters` = `semesterList(catalog)`)에서 **숨김 학기 제외**.
- 수강계획 학기 선택 시 1단계 상단에 "확정 전" 경고(강의검색과 같은 문구).
- 기본 학기: `currentSemester(catalog)` 그대로. 단 홈의 "🪄 마법사로 26-2 짜기"
  버튼으로 진입하면 시드된 `semKey`를 따른다(기존 `seedDraft` 경로).

### 6. `semesterList()` — 숨김 필터 ([cache.js:248-250](../../../src/lib/cache.js#L248))

```js
export function semesterList(catalog) {
  return [...(catalog.semesters ?? [])]
    .filter((s) => !s.hidden)                       // 추가
    .sort((a, b) => b.year - a.year || b.term - a.term);
}
```

호출부 3곳(Wizard, Calc, cache 자체) 모두 학생 대면 — 필터가 안전하다.
관리자 화면(Admin.jsx, AdminCourse.jsx)은 `catalog.semesters`를 직접 순회하므로
영향 없음(숨김도 봐야 함).

### 7. `EmptyRooms.jsx` — 공유 헬퍼로 ([EmptyRooms.jsx:53-56](../../../src/pages/EmptyRooms.jsx#L53))

인라인 현재학기 계산을 `currentSemester(catalog)` 호출로 교체(날짜 인식 일관).

---

## Ⅲ. 성적·등수 입력 학기 분리

개인 기록(성적·등수)의 학기 선택을 편람에서 완전히 떼어낸다 —
스키마가 이미 그렇게 설계돼 있고([schema.sql:311-313](../../../db/schema.sql#L311)),
UI만 어기고 있었다.

### Calc 학기 후보 ([Calc.jsx:61-67](../../../src/pages/Calc.jsx#L61))

```js
const semesters = useMemo(() => {
  const map = new Map();
  // 편람이 아니라 '생성된 범위' — 현재 학기부터 4년 전까지 내림차순
  const cur = currentSemester(catalog) ?? semesterForDate();
  for (let y = cur.year; y >= cur.year - 4; y--)
    for (const t of [2, 1])
      if (y < cur.year || t <= cur.term) map.set(`${y}-${t}`, { year: y, term: t });
  for (const r of rows ?? []) map.set(`${r.year}-${r.term}`, { year: r.year, term: r.term });
  for (const m of manualSems) map.set(`${m.year}-${m.term}`, m);   // 아래 '＋ 다른 학기'
  return [...map.values()].sort((a, b) => b.year - a.year || b.term - a.term);
}, [catalog, rows, manualSems]);
```

- `semesterList(catalog)` 제거 → 편람의 숨김·미래 학기가 성적 드롭다운에서 사라짐.
- **`＋ 다른 학기`** 버튼: 연도·학기 입력 프롬프트 → `manualSems` 상태에 추가
  (localStorage에 기기별 유지 — 첫 성적행을 만들기 전 새로고침해도 남게).
  편람에 없는 과거 학기(앱 출시 전, 편입 전 학교 등)도 첫 성적행을 만들 수 있다.
- 기본 선택: `currentSemester` 가 범위 안이면 그것, 아니면 최신 후보(기존 로직 유지).
- 등수 입력(`rank_entry`, [Calc.jsx:85-99](../../../src/pages/Calc.jsx#L85))은 같은
  `sem` 상태를 공유하므로 자동으로 함께 해결.
- `FailTab` 시드(현재 학기 확정 시간표 → 과목명, [Calc.jsx:391-410](../../../src/pages/Calc.jsx#L391))는
  그대로 — 이건 편람 의존이 맞다.

---

## Ⅳ. 구성요소 요약

| 파일 | 변경 |
|---|---|
| `src/lib/cache.js` | `semesterForDate()` 신규, `currentSemester()` 날짜 인식, `semesterList()` 숨김 필터 |
| `src/lib/timetable.js` | `pickTimetable()` 지난 학기 포인터 유예 창, `selectTimetable()`·`readSelectedAt()` 신규 |
| `src/pages/Home.jsx` | 지난 학기 → 현재 학기 유도 배너, 수강계획 넛지, `handleSelect` → `selectTimetable` |
| `src/pages/CourseSearch.jsx` | 검색 중인 학기 명시 + 지난/수강계획 경고·전환, `pickTimetable` 4-인자, `changeTarget` → `selectTimetable` |
| `src/pages/Wizard.jsx` | 숨김 학기 제외(자동), 수강계획 경고 |
| `src/pages/Calc.jsx` | 학기 후보 생성 범위 + `＋ 다른 학기`, 편람 의존 제거 |
| `src/pages/EmptyRooms.jsx` | 공유 `currentSemester()` 사용 |
| `src/pages/Admin.jsx` | 학기 섹션: 파생 상태 라벨 + `수강계획으로 공개` 버튼 |
| `firebase/functions/src/admin/catalogActions.js` | `ensureSemester` → `hidden: true`; `set_semester` → `hidden: false` 강제; `publish_semester` 액션 신규 |
| `firebase/functions/src/nextClass.js` | `nextClassNotify`에 날짜 백스톱 승격 판정 |
| `firebase/firestore.rules` | `semesters` 읽기 규칙 변화 없음(이미 `allow read: if signed-in`), 쓰기는 함수 전용 유지 |

## Ⅴ. 테스트

- **순수 로직**: `semesterForDate` 경계(2/28, 3/1, 7/31, 8/1, 12/31, 1/1), `currentSemester` 우선순위(flagged<dated / dated 카탈로그 부재 → flagged / 전부 숨김), `pickTimetable`(지난 포인터: 유예 내 유지·유예 만료 시 무시·타임스탬프 없음 시 무시, 미래 포인터 항상 유지, 현재 확정본 폴백).
- **컴포넌트**: 홈 배너 노출 조건(지난 학기 선택 시 표시 / 현재·미래 시 숨김), 강의검색 학기 라벨.
- **수동**: 26-1만 있는 계정으로 로그인 → 홈 배너 → 마법사 26-2 시드 확인. 관리자 학기 추가 → 생도 화면에서 안 보임 → `수강계획으로 공개` → 마법사에 "확정 전" 배지와 함께 등장.
- **수동(유예 창)**: 26-1·26-2 둘 다 있는 계정에서 스위처로 26-1 전환 → 앱 재시작 → 26-1 유지(배너는 뜸). 26-2로 전환 후 재시작 → 26-2 유지. `selectedTimetableAt`을 15일 전으로 조작 후 재시작 → 26-2로 스냅.
- **배포 후**: `nextClassNotify` 로그에 승격 판정 오류 없는지, 26-1 갇힘 리포트가 줄어드는지.

## Ⅵ. 범위 밖 (YAGNI)

- 학기별 정확한 학사일정(개강일·종강일·시험기간) 데이터 — 3월/8월 고정 경계로 충분.
- 수강계획 학기의 편람 "확정" 별도 플래그(공개=조정 가능이면 족함, 확정 후 조정은 기존 리싱크·겹침 배너가 처리).
- 과거 학기 시간표 자동 아카이브/정리.
- **앱 리포트 회신 루프 — 별도 스펙(Ⅶ)**.

## Ⅶ. 후속: 앱 리포트 회신 (별도 스펙 예정)

`appReports`는 작성자 정보 미저장, 푸시 구독도 uid 없음([push.js:35-37](../../../firebase/functions/src/push.js#L35)) —
익명성 설계. 사용자가 리포트한 내용에 관리자가 회신할 수 있게 하되 익명성을 지키는 방향:

- 제출 시 기기가 자기 리포트 ID를 localStorage에 기록. 푸시 구독이 있으면 그
  **구독 해시**(uid 아님)를 리포트 문서에 첨부.
- 관리자: Moderation "앱 문제" 탭 카드에 답변 입력 + 상태(`검토중`/`해결됨`/`반영예정`).
  답변이 달리면 즉시삭제 대신 보존.
- 회신 전달 두 경로: (a) 구독 해시로 푸시 1건, (b) **앱 리포트 화면에 회신 내용
  표시** — 기기가 앱 열 때 자기 리포트 ID들의 답변·상태를 확인해 인앱 "내 리포트"
  목록으로. 푸시 미구독자도 (b)로 받는다.
- 서버에 신원 0 — 기기가 기억하는 리포트 ID + 이미 준 푸시 핸들로만 연결.

이 스펙(Ⅰ~Ⅲ) 구현·배포 후 착수. 지금 갇힌 사용자부터 푼다.
