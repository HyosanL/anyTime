# 학기 생명주기 · 학생 방향 잡기 · 성적 학기 분리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 새 학기가 시작됐을 때 사용자가 지난 학기에 갇히지 않고 옳은 학기를 보게 하고, 관리자가 편람을 입력 중인 학기는 생도에게 숨기며, 성적 입력 학기를 편람에서 분리한다.

**Architecture:** "현재 학기"는 클라이언트가 날짜(3월/8월 경계)로 파생하고 `semester.isCurrent` 플래그를 하한선으로만 쓴다 — 순수 로직은 의존성 0인 새 모듈 `src/lib/semesterPhase.js`에 모으고 `cache.js`·`timetable.js`가 재사용한다. 학기 문서에 `hidden` 불리언 하나를 더해 숨김/수강계획/현재/지난 4상태를 현재 학기 대비 위치로 파생한다. 지난 학기 시간표 포인터는 스위처에서 명시적으로 고른 뒤 14일까지만 존중한다(add/drop 참고 창).

**Tech Stack:** React 19 + Vite (프론트), Firebase Cloud Functions v2 (Node 22, Firestore), Cloudflare Pages. **테스트 프레임워크 없음** — 순수 로직은 `node`로 돌리는 일회용 스크래치 스크립트(scratchpad에 두고 커밋 안 함, `docs/superpowers/specs/2026-09-01-next-class-alert-design.md` §Ⅷ 관례)로, 통합은 `npm run build` + 배포 후 실기기 확인으로 검증한다.

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-09-03-semester-lifecycle-and-orientation-design.md`.
- `db/schema.sql`(레거시 Supabase)은 **건드리지 않는다** — 카탈로그는 완전히 Firestore다([cache.js:13-39](../../../src/lib/cache.js#L13)). 이 계획은 Firestore + 프론트만 만진다. [[live-schema-no-full-rerun]]
- 대화는 한국어, 코드·주석·커밋 메시지는 영어 유지. [[chat-korean-work-english]]
- 커밋 메시지 끝에 `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- **"배포" = `git push origin main`.** Firebase는 `.github/workflows/deploy-firebase.yml`이 `firebase/**` 변경 시 자동 배포(이 샌드박스에서 직접 못 함). Cloudflare Pages는 같은 push에 Git 연동으로 프론트를 재빌드. [[pages-deploy-model]]
- 새 학기 문서의 `hidden` 필드는 **backward-compatible** — 기존 문서에 없으면 `!s.hidden`이 `true`(보임)로 취급되어 지금과 동작이 같다. `cache.js`의 `SCHEMA_VERSION`은 **올리지 않는다**(강제 전원 재다운로드 불필요). 첫 관리자 학기 액션이 `catalogVersion`을 올려 자연히 전파된다.
- 색은 항상 `var(--token)`, 새 CSS는 `src/styles/` 파셜에. [[design-system-tokens]]
- `currentSemester(catalog)` 호출부는 모두 인자 1개 그대로 둔다 — 새 `now` 파라미터는 기본값이 있어 backward-compatible.

---

### Task 1: `src/lib/semesterPhase.js` — 순수 학기 로직 모듈

의존성 0인 새 모듈. `cache.js`(idb·firebase import 때문에 node로 못 돌림)와 분리해 스크래치 스크립트가 직접 import 할 수 있게 한다.

**Files:**
- Create: `src/lib/semesterPhase.js`

**Interfaces:**
- Produces: `semesterForDate(d?) → { year, term }` — 날짜 → 학사 학기(1학기=3~7월, 2학기=8~12월, 1~2월=지난 2학기).
- Produces: `resolveCurrentSemester(semesters, now?) → { year, term, isCurrent?, hidden? } | null` — 비숨김 학기 중 `isCurrent` 플래그와 날짜 파생 중 더 최근 것(카탈로그에 있는 학기까지만), 없으면 가장 최근 비숨김.
- Produces: `semesterPhaseOf(semesters, year, term, now?) → 'hidden' | 'planning' | 'current' | 'past'`.
- Produces: `honorsPreferred(preferred, current, preferredAt?, now?) → boolean` — 포인터가 가리키는 시간표 학기를 존중할지(현재·미래면 항상, 지난 학기면 14일 유예 내에서만).
- Produces: `PAST_GRACE_MS` 상수.

- [ ] **Step 1: 모듈 작성**

Create `src/lib/semesterPhase.js`:

```js
// =====================================================================
//  학기 판정 순수 로직 — 의존성 0 (cache.js·timetable.js 가 재사용).
//  "현재 학기"는 관리자 플래그(semester.isCurrent)를 하한선으로, 날짜가
//  그를 앞지르면 날짜가 이긴다. 단 카탈로그에 데이터가 있는 학기까지만.
//  설계: docs/superpowers/specs/2026-09-03-semester-lifecycle-and-orientation-design.md
// =====================================================================

// add/drop 기간에 지난 학기 시간표를 참고용으로 띄워 두는 창.
export const PAST_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

const key = (s) => s.year * 10 + s.term;

// 경계: 1학기 3월, 2학기 8월 시작(사관학교 학사일정 근사). 1~2월은 겨울방학 —
// 아직 다음 1학기가 시작 안 됐으니 지난 2학기로 친다.
export function semesterForDate(d = new Date()) {
  const m = d.getMonth() + 1;
  if (m >= 3 && m <= 7) return { year: d.getFullYear(), term: 1 };
  if (m >= 8) return { year: d.getFullYear(), term: 2 };
  return { year: d.getFullYear() - 1, term: 2 };
}

// semesters: [{ year, term, isCurrent?, hidden? }]
// current = max( 관리자 플래그, 날짜가 가리키는 학기 ). 플래그는 '더 최근으로 앞당길' 때만
// 이긴다(관리자가 학기 시작 전에 현재로 지정하는 경우). 플래그가 뒤처져 있으면(흔한 실수)
// 날짜가 앞선다. 날짜가 카탈로그에 없는 미래 학기를 가리키면 '미래가 아닌 가장 최근' 학기.
export function resolveCurrentSemester(semesters, now = new Date()) {
  const visible = (semesters ?? []).filter((s) => !s.hidden);
  if (!visible.length) return null;
  const byKeyDesc = [...visible].sort((a, b) => key(b) - key(a));
  const impliedKey = key(semesterForDate(now));
  const flagged = visible.find((s) => s.isCurrent) ?? null;
  const dated =
    visible.find((s) => key(s) === impliedKey) ??
    byKeyDesc.find((s) => key(s) <= impliedKey) ??
    null;
  const cands = [flagged, dated].filter(Boolean);
  if (!cands.length) return byKeyDesc[0];
  return cands.sort((a, b) => key(b) - key(a))[0];
}

export function semesterPhaseOf(semesters, year, term, now = new Date()) {
  const s = (semesters ?? []).find((x) => x.year === year && x.term === term);
  if (!s || s.hidden) return 'hidden';
  const cur = resolveCurrentSemester(semesters, now);
  if (!cur) return 'planning';
  const k = year * 10 + term;
  const ck = cur.year * 10 + cur.term;
  if (k === ck) return 'current';
  return k > ck ? 'planning' : 'past';
}

// preferred / current: { year, term }. preferredAt: 마지막 '명시적 전환' 타임스탬프(ms).
export function honorsPreferred(preferred, current, preferredAt = 0, now = Date.now()) {
  if (!preferred) return false;
  if (!current) return true;
  const past = key(preferred) < key(current);
  if (!past) return true;                       // 현재·미래(수강계획): 항상 존중
  return now - preferredAt < PAST_GRACE_MS;     // 지난 학기: 유예 창 안에서만
}
```

- [ ] **Step 2: 스크래치 검증 스크립트 작성**

Create `<scratchpad>/verify-semesterPhase.mjs` (scratchpad 디렉터리 = 시스템 프롬프트에 명시된 경로):

```js
import {
  semesterForDate, resolveCurrentSemester, semesterPhaseOf, honorsPreferred, PAST_GRACE_MS,
} from 'file:///d:/anyTime/anyTime/src/lib/semesterPhase.js';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// semesterForDate 경계
eq('feb -> prev term2', semesterForDate(new Date('2027-02-28T12:00:00')), { year: 2026, term: 2 });
eq('mar 1 -> term1',    semesterForDate(new Date('2027-03-01T12:00:00')), { year: 2027, term: 1 });
eq('jul 31 -> term1',   semesterForDate(new Date('2026-07-31T12:00:00')), { year: 2026, term: 1 });
eq('aug 1 -> term2',    semesterForDate(new Date('2026-08-01T12:00:00')), { year: 2026, term: 2 });
eq('dec 31 -> term2',   semesterForDate(new Date('2026-12-31T12:00:00')), { year: 2026, term: 2 });
eq('jan 1 -> prev term2', semesterForDate(new Date('2027-01-01T12:00:00')), { year: 2026, term: 2 });

const S = [
  { year: 2025, term: 2 },
  { year: 2026, term: 1, isCurrent: true },
  { year: 2026, term: 2 },
];
// 2026-09: 날짜는 26-2, 플래그는 26-1 -> 날짜가 이긴다
eq('dated beats flagged', resolveCurrentSemester(S, new Date('2026-09-03T12:00:00')),
   { year: 2026, term: 2 });
// 2026-05: 날짜는 26-1, 플래그도 26-1
eq('flagged during term', resolveCurrentSemester(S, new Date('2026-05-03T12:00:00')),
   { year: 2026, term: 1, isCurrent: true });
// 날짜가 가리키는 27-1 이 카탈로그에 없음 -> 플래그(26-1)로 폴백? 아니 -> 가장 최근 비숨김(26-2)
eq('implied not in catalog -> flagged or latest', resolveCurrentSemester(S, new Date('2027-03-03T12:00:00')),
   { year: 2026, term: 2 });
// 전부 숨김
eq('all hidden -> null', resolveCurrentSemester(
   [{ year: 2026, term: 2, hidden: true }], new Date('2026-09-03')), null);

// phase
const S2 = [
  { year: 2026, term: 1 },
  { year: 2026, term: 2, isCurrent: true },
  { year: 2027, term: 1, hidden: true },
  { year: 2027, term: 2 }, // visible future = planning (설명용, 학사상 비현실적이지만 로직 확인)
];
const now = new Date('2026-09-03T12:00:00');
eq('phase past',     semesterPhaseOf(S2, 2026, 1, now), 'past');
eq('phase current',  semesterPhaseOf(S2, 2026, 2, now), 'current');
eq('phase hidden',   semesterPhaseOf(S2, 2027, 1, now), 'hidden');
eq('phase planning', semesterPhaseOf(S2, 2027, 2, now), 'planning');
eq('phase missing',  semesterPhaseOf(S2, 2099, 1, now), 'hidden');

// honorsPreferred
const cur = { year: 2026, term: 2 };
eq('honor current',  honorsPreferred({ year: 2026, term: 2 }, cur, 0, Date.now()), true);
eq('honor future',   honorsPreferred({ year: 2027, term: 1 }, cur, 0, Date.now()), true);
eq('past no stamp',   honorsPreferred({ year: 2026, term: 1 }, cur, 0, Date.now()), false);
eq('past fresh stamp', honorsPreferred({ year: 2026, term: 1 }, cur, Date.now() - 1000, Date.now()), true);
eq('past stale stamp', honorsPreferred({ year: 2026, term: 1 }, cur, Date.now() - PAST_GRACE_MS - 1, Date.now()), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 3: 스크래치 스크립트 실행 — 전부 통과 확인**

Run: `node "<scratchpad>/verify-semesterPhase.mjs"`
Expected: `20 passed, 0 failed`, exit 0.

- [ ] **Step 4: 스크래치 스크립트 삭제, 커밋**

```bash
rm "<scratchpad>/verify-semesterPhase.mjs"
git add src/lib/semesterPhase.js
git commit -m "feat: add semesterPhase — pure date-aware semester resolution

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `cache.js` — 날짜 인식 `currentSemester` + 숨김 필터

**Files:**
- Modify: `src/lib/cache.js:237-250`

**Interfaces:**
- Consumes: Task 1 `resolveCurrentSemester`, `semesterForDate`, `semesterPhaseOf`.
- Produces: `currentSemester(catalog, now?)` — 이제 날짜 인식. `semesterList(catalog)` — 숨김 학기 제외. `semesterForDate`, `semesterPhaseOf` re-export.

- [ ] **Step 1: import 추가**

`src/lib/cache.js` 상단 import 블록(현재 [cache.js:13-16](../../../src/lib/cache.js#L13))에 추가:

```js
import { openDB } from 'idb';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { fetchBootInfo } from './appInfo';
import { resolveCurrentSemester, semesterForDate, semesterPhaseOf } from './semesterPhase';
```

- [ ] **Step 2: `currentSemester` / `semesterList` 교체**

Find (currently [cache.js:237-250](../../../src/lib/cache.js#L237)):

```js
// isCurrent 학기. 없으면 가장 최근 학기.
export function currentSemester(catalog) {
  const semesters = catalog.semesters ?? [];
  return (
    semesters.find((s) => s.isCurrent) ??
    [...semesters].sort((a, b) => b.year - a.year || b.term - a.term)[0] ??
    null
  );
}

// 최신순 학기 목록(시간표 만들 때 고르는 후보)
export function semesterList(catalog) {
  return [...(catalog.semesters ?? [])].sort((a, b) => b.year - a.year || b.term - a.term);
}
```

Replace with:

```js
// 현재 학기 — 관리자 플래그(isCurrent)를 하한선으로, 날짜(3월/8월 경계)가 앞지르면
// 날짜가 이긴다. 순수 로직은 semesterPhase.js(의존성 0, 스크래치 테스트 대상).
export function currentSemester(catalog, now = new Date()) {
  return resolveCurrentSemester(catalog.semesters ?? [], now);
}

// 학생 대면 학기 목록 — 숨김(관리자 편람 입력 중) 학기는 뺀다. 최신순.
export function semesterList(catalog) {
  return [...(catalog.semesters ?? [])]
    .filter((s) => !s.hidden)
    .sort((a, b) => b.year - a.year || b.term - a.term);
}

// 특정 학기의 상태('hidden' | 'planning' | 'current' | 'past') — 배너·경고 분기용.
export function semesterPhase(catalog, year, term, now = new Date()) {
  return semesterPhaseOf(catalog.semesters ?? [], year, term, now);
}

export { semesterForDate };
```

- [ ] **Step 3: 빌드 통과 확인**

Run: `npm run build`
Expected: 성공(에러 없음). `currentSemester`·`semesterList` 호출부는 시그니처가 backward-compatible이라 변경 불필요.

- [ ] **Step 4: 커밋**

```bash
git add src/lib/cache.js
git commit -m "feat: currentSemester is date-aware; semesterList hides admin-only semesters

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `timetable.js` — 지난 학기 포인터 유예 창

**Files:**
- Modify: `src/lib/timetable.js:14-17` (import), `src/lib/timetable.js:48-64` (선택 포인터 헬퍼 + `pickTimetable`)

**Interfaces:**
- Consumes: Task 1 `honorsPreferred`.
- Produces: `selectTimetable(id)` — 명시적 전환(타임스탬프 기록). `readSelectedAt() → number`. `pickTimetable(list, current, preferredId?, preferredAt?)` — 4번째 인자 추가.

- [ ] **Step 1: import 추가**

`src/lib/timetable.js` 상단(현재 [timetable.js:14-17](../../../src/lib/timetable.js#L14)):

```js
import { collection, getDocs, query, where } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { callFn } from './functions';
import { kvGet, kvSet, kvDel } from './cache';
import { honorsPreferred } from './semesterPhase';
```

- [ ] **Step 2: 선택 포인터 헬퍼 + `pickTimetable` 교체**

Find (currently [timetable.js:48-64](../../../src/lib/timetable.js#L48)):

```js
// ── 마지막으로 본 시간표(기기 기억) ──────────────────────────────────
// 옛 시간표 id 는 BIGINT 라 숫자로 저장했지만 Firestore 문서ID 는 문자열이다 — 그대로 저장·비교.
export function readSelectedId() {
  try { return localStorage.getItem(SELECTED_KEY) || null; } catch { return null; }
}
export function writeSelectedId(id) {
  try { localStorage.setItem(SELECTED_KEY, String(id)); } catch { /* ignore */ }
}

// 기억해 둔 시간표가 목록에 없으면(삭제됨·다른 기기) 현재 학기 확정 → 아무거나로 되돌린다.
export function pickTimetable(list, current, preferredId = null) {
  if (!list?.length) return null;
  const byId = preferredId && list.find((t) => t.id === preferredId);
  if (byId) return byId;
  const cur = current && list.find((t) => t.year === current.year && t.term === current.term && t.isPrimary);
  return cur ?? list.find((t) => t.isPrimary) ?? list[0];
}
```

Replace with:

```js
// ── 마지막으로 본 시간표(기기 기억) ──────────────────────────────────
// 옛 시간표 id 는 BIGINT 라 숫자로 저장했지만 Firestore 문서ID 는 문자열이다 — 그대로 저장·비교.
const SELECTED_AT_KEY = 'anytime:selectedTimetableAt';

export function readSelectedId() {
  try { return localStorage.getItem(SELECTED_KEY) || null; } catch { return null; }
}
// 수동 복원(홈 이펙트) 등에서 부르는 조용한 미러 — 타임스탬프를 남기지 않는다.
export function writeSelectedId(id) {
  try { localStorage.setItem(SELECTED_KEY, String(id)); } catch { /* ignore */ }
}
// 사용자가 스위처·검색에서 직접 고른 전환 — 타임스탬프를 남겨 지난 학기 유예 창의 기준으로 쓴다.
export function selectTimetable(id) {
  writeSelectedId(id);
  try { localStorage.setItem(SELECTED_AT_KEY, String(Date.now())); } catch { /* ignore */ }
}
export function readSelectedAt() {
  try { return Number(localStorage.getItem(SELECTED_AT_KEY)) || 0; } catch { return 0; }
}

// 기억해 둔 시간표가 목록에 없으면(삭제됨·다른 기기) 현재 학기 확정 → 아무거나로 되돌린다.
// 지난 학기를 가리키는 포인터는 '명시적 전환 후 14일'(honorsPreferred) 안에서만 존중한다 —
// 그 밖에는 현재 학기 확정본으로. 작년에 만든 지난 학기 시간표에 갇히지 않게.
export function pickTimetable(list, current, preferredId = null, preferredAt = 0) {
  if (!list?.length) return null;
  const byId = preferredId && list.find((t) => t.id === preferredId);
  if (byId && honorsPreferred(byId, current, preferredAt, Date.now())) return byId;
  const cur = current && list.find((t) => t.year === current.year && t.term === current.term && t.isPrimary);
  return cur ?? list.find((t) => t.isPrimary) ?? list[0];
}
```

- [ ] **Step 3: 스크래치 검증**

Create `<scratchpad>/verify-pick.mjs`:

```js
import { honorsPreferred } from 'file:///d:/anyTime/anyTime/src/lib/semesterPhase.js';

// pickTimetable 의 핵심 분기를 재현(모듈은 firebase import 때문에 직접 못 부름).
function pickTimetable(list, current, preferredId = null, preferredAt = 0) {
  if (!list?.length) return null;
  const byId = preferredId && list.find((t) => t.id === preferredId);
  if (byId && honorsPreferred(byId, current, preferredAt, Date.now())) return byId;
  const cur = current && list.find((t) => t.year === current.year && t.term === current.term && t.isPrimary);
  return cur ?? list.find((t) => t.isPrimary) ?? list[0];
}

const list = [
  { id: 'b', year: 2026, term: 2, isPrimary: true },
  { id: 'a', year: 2026, term: 1, isPrimary: true },
];
const cur = { year: 2026, term: 2 };
let pass = 0, fail = 0;
const eq = (l, g, w) => { const ok = g === w; console.log(`${ok?'PASS':'FAIL'} ${l} got=${g} want=${w}`); ok?pass++:fail++; };

eq('past pointer, no stamp -> current primary', pickTimetable(list, cur, 'a', 0).id, 'b');
eq('past pointer, stale stamp -> current primary', pickTimetable(list, cur, 'a', Date.now() - 20*864e5).id, 'b');
eq('past pointer, fresh stamp -> honored', pickTimetable(list, cur, 'a', Date.now() - 1000).id, 'a');
eq('current pointer -> honored', pickTimetable(list, cur, 'b', 0).id, 'b');
eq('no current primary -> latest primary + (banner elsewhere)',
   pickTimetable([{ id: 'a', year: 2026, term: 1, isPrimary: true }], cur, 'a', 0).id, 'a');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

Run: `node "<scratchpad>/verify-pick.mjs"`
Expected: `5 passed, 0 failed`.

- [ ] **Step 4: 빌드 + 삭제 + 커밋**

```bash
npm run build          # 성공 확인
rm "<scratchpad>/verify-pick.mjs"
git add src/lib/timetable.js
git commit -m "feat: past-semester timetable pointer honored only within a 14-day grace window

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: 호출부 갱신 — `pickTimetable` 4-인자 + `selectTimetable`

**Files:**
- Modify: `src/pages/Home.jsx` (import, `refreshList`, 초기 이펙트, `handleRefresh`, `handleSelect`, `handleCreate`)
- Modify: `src/pages/CourseSearch.jsx` (import, `loadCatalog`/`loadTimetables`, `changeTarget`)
- Modify: `src/pages/Wizard.jsx` (import, `finish`)

**Interfaces:**
- Consumes: Task 2 `currentSemester`, Task 3 `selectTimetable`/`readSelectedAt`/`pickTimetable`.

- [ ] **Step 1: Home.jsx — import 에 `selectTimetable`, `readSelectedAt` 추가**

Find [Home.jsx:14-18](../../../src/pages/Home.jsx#L14):

```js
import {
  listTimetables, readTimetablesCache, listEntries, readEntriesCache,
  createTimetable, renameTimetable, setPrimaryTimetable, deleteTimetable,
  readSelectedId, writeSelectedId, pickTimetable, isOverlapError,
} from '../lib/timetable';
```

Replace with:

```js
import {
  listTimetables, readTimetablesCache, listEntries, readEntriesCache,
  createTimetable, renameTimetable, setPrimaryTimetable, deleteTimetable,
  readSelectedId, writeSelectedId, selectTimetable, readSelectedAt, pickTimetable, isOverlapError,
} from '../lib/timetable';
```

- [ ] **Step 2: Home.jsx — `pickTimetable` 호출 4곳에 `readSelectedAt()` 추가**

네 곳 모두 `readSelectedId()` 뒤에 `, readSelectedAt()` 를 붙인다:

1. `refreshList` ([Home.jsx:170](../../../src/pages/Home.jsx#L170)):
   `const pick = pickTimetable(list, cur, preferId ?? readSelectedId(), readSelectedAt());`
2. 초기 이펙트 cachedPick ([Home.jsx:190](../../../src/pages/Home.jsx#L190)):
   `const cachedPick = pickTimetable(cachedList, cur, readSelectedId(), readSelectedAt());`
3. 초기 이펙트 list ([Home.jsx:210](../../../src/pages/Home.jsx#L210)):
   `setSelectedId(pickTimetable(list, cur, readSelectedId(), readSelectedAt())?.id ?? null);`
4. `handleRefresh` ([Home.jsx:255](../../../src/pages/Home.jsx#L255)):
   `const pick = pickTimetable(list, currentSemester(cat), readSelectedId(), readSelectedAt());`

- [ ] **Step 3: Home.jsx — 명시적 전환을 `selectTimetable` 로**

`handleSelect` ([Home.jsx:292](../../../src/pages/Home.jsx#L292)):

```js
const handleSelect = useCallback((id) => { selectTimetable(id); setSelectedId(id); }, []);
```

`handleCreate` ([Home.jsx:294-298](../../../src/pages/Home.jsx#L294)):

```js
const handleCreate = useCallback(async ({ year, term, name }) => {
  const made = await createTimetable({ uid, year, term, name });
  selectTimetable(made.id);
  await refreshList(made.id);
}, [uid, refreshList]);
```

- [ ] **Step 4: CourseSearch.jsx — import + catalog 로드 순서 + `changeTarget`**

Find [CourseSearch.jsx:5-8](../../../src/pages/CourseSearch.jsx#L5):

```js
import {
  listTimetables, listEntries, addSection, removeSection,
  readSelectedId, writeSelectedId, pickTimetable, isOverlapError,
} from '../lib/timetable';
```

Replace with:

```js
import {
  listTimetables, listEntries, addSection, removeSection,
  readSelectedId, selectTimetable, readSelectedAt, pickTimetable, isOverlapError,
} from '../lib/timetable';
```

(`writeSelectedId` 제거 — `changeTarget` 이 `selectTimetable` 로 바뀐다.)

Find [CourseSearch.jsx:46-69](../../../src/pages/CourseSearch.jsx#L46) (`loadCatalog` + `loadTimetables`):

```js
  async function loadCatalog(force = false) {
    if (!force) setLoading(true);
    setError('');
    try {
      const cat = await getCatalog({ force });
      setCatalog(cat);
      setMeta(correctionMeta(cat));
    } catch {
      setError('카탈로그를 불러오지 못했습니다. (오프라인이고 캐시도 없음)');
    } finally {
      setLoading(false);
    }
  }

  async function loadTimetables() {
    if (!uid) return;
    try {
      const list = await listTimetables();
      setTimetables(list);
      // 홈에서 고른 시간표가 사라졌으면 확정으로 되돌린다.
      const pick = pickTimetable(list, null, readSelectedId());
      setTargetId(pick?.id ?? null);
    } catch { /* 오프라인 → 빈 목록 */ }
  }
```

Replace with:

```js
  async function loadCatalog(force = false) {
    if (!force) setLoading(true);
    setError('');
    try {
      const cat = await getCatalog({ force });
      setCatalog(cat);
      setMeta(correctionMeta(cat));
      return cat;
    } catch {
      setError('카탈로그를 불러오지 못했습니다. (오프라인이고 캐시도 없음)');
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function loadTimetables(cat = catalog) {
    if (!uid) return;
    try {
      const list = await listTimetables();
      setTimetables(list);
      // 홈에서 고른 시간표가 사라졌거나 지난 학기면 현재 학기 확정본으로 되돌린다.
      const cur = cat ? currentSemester(cat) : null;
      const pick = pickTimetable(list, cur, readSelectedId(), readSelectedAt());
      setTargetId(pick?.id ?? null);
    } catch { /* 오프라인 → 빈 목록 */ }
  }
```

Find the mount effect [CourseSearch.jsx:71-75](../../../src/pages/CourseSearch.jsx#L71):

```js
  useEffect(() => {
    loadCatalog();
    loadTimetables();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);
```

Replace with:

```js
  useEffect(() => {
    loadCatalog().then((cat) => loadTimetables(cat));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);
```

Also update the `PullToRefresh` onRefresh [CourseSearch.jsx:193](../../../src/pages/CourseSearch.jsx#L193):

```jsx
    <PullToRefresh className="page" onRefresh={() => Promise.all([loadCatalog(true), loadTimetables()])}>
```

→

```jsx
    <PullToRefresh className="page" onRefresh={() => loadCatalog(true).then((cat) => loadTimetables(cat))}>
```

Add `currentSemester` to the cache import [CourseSearch.jsx:4](../../../src/pages/CourseSearch.jsx#L4):

```js
import { getCatalog, subscribeCatalog, buildSections, formatTimes } from '../lib/cache';
```

→

```js
import { getCatalog, subscribeCatalog, buildSections, formatTimes, currentSemester } from '../lib/cache';
```

(Task 9 이 같은 줄에 `semesterPhase` 를 더 추가한다.)

Find `changeTarget` [CourseSearch.jsx:108-111](../../../src/pages/CourseSearch.jsx#L108):

```js
  function changeTarget(id) {
    writeSelectedId(id);      // 홈과 선택을 공유한다
    setTargetId(id);
  }
```

Replace with:

```js
  function changeTarget(id) {
    selectTimetable(id);      // 홈과 선택을 공유한다(명시적 전환 — 타임스탬프 기록)
    setTargetId(id);
  }
```

- [ ] **Step 5: Wizard.jsx — `finish` 의 `writeSelectedId` → `selectTimetable`**

Find [Wizard.jsx:10](../../../src/pages/Wizard.jsx#L10):

```js
  addSections, findEmptyTimetables, writeSelectedId, isOverlapError,
```

Replace with:

```js
  addSections, findEmptyTimetables, selectTimetable, isOverlapError,
```

Find [Wizard.jsx:605-608](../../../src/pages/Wizard.jsx#L605):

```js
      if (primaryId) {
        await setPrimaryTimetable(primaryId);
        writeSelectedId(primaryId);
      }
```

Replace with:

```js
      if (primaryId) {
        await setPrimaryTimetable(primaryId);
        selectTimetable(primaryId);   // 방금 마법사로 짠 학기로 이동(명시적)
      }
```

- [ ] **Step 6: 빌드 + 커밋**

```bash
npm run build          # 성공 확인 (eslint no-unused-vars: writeSelectedId 잔존 없음 확인)
git add src/pages/Home.jsx src/pages/CourseSearch.jsx src/pages/Wizard.jsx
git commit -m "feat: pass semester + selection timestamp through pickTimetable call sites

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: 백엔드 — `hidden` 필드 + 관리자 공개 액션

**Files:**
- Modify: `firebase/functions/src/admin/catalogActions.js:52-61` (`ensureSemester`), `:215-233` (`setSemester`)

**Interfaces:**
- Produces: 새 `semesters` 문서는 `hidden: true` 로 생성. `set_semester` 페이로드에 `{ hidden: false }` → 숨김 해제(공개). `{ isCurrent: true }` → 대상 문서 `hidden` 도 `false` 강제.

- [ ] **Step 1: `ensureSemester` — `hidden: true` 로 생성**

Find [catalogActions.js:56-61](../../../firebase/functions/src/admin/catalogActions.js#L56):

```js
  const ref = db.collection('semesters').doc(semesterKey(y, t));
  const snap = await ref.get();
  if (snap.exists) return;
  await ref.set({ year: y, term: t, isCurrent: false });
  await CONFIG_APP_REF().update({ catalogVersion: FieldValue.increment(1) });
```

Replace with:

```js
  const ref = db.collection('semesters').doc(semesterKey(y, t));
  const snap = await ref.get();
  if (snap.exists) return;
  // 새 학기는 숨김으로 시작 — 관리자가 편람을 다 넣고 '수강계획으로 공개'해야
  // 생도 화면(마법사·강의검색·계산기)에 뜬다. 설계 §Ⅰ.
  await ref.set({ year: y, term: t, isCurrent: false, hidden: true });
  await CONFIG_APP_REF().update({ catalogVersion: FieldValue.increment(1) });
```

- [ ] **Step 2: `setSemester` — isCurrent 시 hidden:false 강제 + publish 분기**

Find [catalogActions.js:215-233](../../../firebase/functions/src/admin/catalogActions.js#L215):

```js
async function setSemester(uid, payload) {
  const year = Number(payload.year);
  const term = Number(payload.term);
  if (!Number.isInteger(year) || (term !== 1 && term !== 2)) invalid('학기 정보가 올바르지 않습니다.');

  if (payload.isCurrent) {
    const currentSnap = await db.collection('semesters').where('isCurrent', '==', true).get();
    const batch = db.batch();
    for (const d of currentSnap.docs) batch.update(d.ref, { isCurrent: false });
    batch.set(db.collection('semesters').doc(semesterKey(year, term)), { year, term, isCurrent: true }, { merge: true });
    batch.update(CONFIG_APP_REF(), { catalogVersion: FieldValue.increment(1) });
    await batch.commit();
  } else {
    // '추가'(다음 학기 미리 열기) — 이미 있으면 손대지 않는다. upsert 로 isCurrent:false
    // 를 덮어쓰면 현재 학기를 강등시켜 버리므로 ensureSemester(존재 체크 후 생성)로만.
    await ensureSemester(year, term);
  }
  return { status: 'OK' };
}
```

Replace with:

```js
async function setSemester(uid, payload) {
  const year = Number(payload.year);
  const term = Number(payload.term);
  if (!Number.isInteger(year) || (term !== 1 && term !== 2)) invalid('학기 정보가 올바르지 않습니다.');

  if (payload.isCurrent) {
    const currentSnap = await db.collection('semesters').where('isCurrent', '==', true).get();
    const batch = db.batch();
    for (const d of currentSnap.docs) batch.update(d.ref, { isCurrent: false });
    // 현재 학기는 절대 숨김일 수 없다 — hidden:false 를 함께 박는다.
    batch.set(db.collection('semesters').doc(semesterKey(year, term)),
      { year, term, isCurrent: true, hidden: false }, { merge: true });
    batch.update(CONFIG_APP_REF(), { catalogVersion: FieldValue.increment(1) });
    await batch.commit();
  } else if (payload.hidden === false) {
    // '수강계획으로 공개' — 숨김 해제. 생도가 이 학기 시간표를 짤 수 있게 된다.
    const ref = db.collection('semesters').doc(semesterKey(year, term));
    const snap = await ref.get();
    if (!snap.exists) invalid('먼저 학기를 추가하세요.');
    const batch = db.batch();
    batch.update(ref, { hidden: false });
    batch.update(CONFIG_APP_REF(), { catalogVersion: FieldValue.increment(1) });
    await batch.commit();
  } else {
    // '추가'(다음 학기 미리 열기) — 이미 있으면 손대지 않는다. ensureSemester 가
    // hidden:true 로 생성. upsert 로 덮어쓰면 현재 학기를 강등시키므로 존재 체크만.
    await ensureSemester(year, term);
  }
  return { status: 'OK' };
}
```

- [ ] **Step 3: 문법 확인**

Run: `node --check firebase/functions/src/admin/catalogActions.js`
Expected: 출력 없음(문법 OK). (functions 는 테스트·빌드 스텝이 없다 — `node --check` 로 파싱만 확인.)

- [ ] **Step 4: 커밋**

```bash
git add firebase/functions/src/admin/catalogActions.js
git commit -m "feat: new semesters start hidden; set_semester gains a publish branch

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: 백엔드 — 일일 `rolloverSemester` 스케줄 함수

`isCurrent` 플래그를 날짜에 맞춰 따라잡게 한다(관리자가 '현재 학기로 설정'을 잊어도). 백엔드 3곳(`getSharedGallery`·`purgePastMemos`·팔로우 갤러리)이 `where('isCurrent')` 를 쓰므로 플래그도 결국 넘어가야 한다. 매분 함수 오염 대신 하루 1회.

**Files:**
- Create: `firebase/functions/src/semester.js`
- Modify: `firebase/functions/index.js` (마지막 export 블록)

**Interfaces:**
- Produces: `rolloverSemester` (onSchedule, 매일 00:05 KST) — 날짜가 가리키는 비숨김 학기가 카탈로그에 있고 아직 현재가 아니면 `isCurrent` 를 그리로 옮기고 `catalogVersion` +1. 앞으로만(과거로 강등 안 함).

- [ ] **Step 1: `firebase/functions/src/semester.js` 작성**

```js
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db, FieldValue } from './lib/context.js';

// 날짜 백스톱 — 관리자가 '현재 학기로 설정'을 잊어도, 학기 시작일(1학기 3/1, 2학기 8/1)이
// 지나고 그 학기 편람이 공개돼 있으면 isCurrent 를 자동으로 옮긴다. 앞으로만 움직인다.
// 클라이언트는 이미 semesterPhase.js 로 날짜를 인식하므로 이건 백엔드 쿼리(getSharedGallery·
// purgePastMemos) 정확도를 위한 2차 보정이다. 설계: docs/superpowers/specs/2026-09-03-semester-lifecycle-and-orientation-design.md §Ⅰ.
//
// semesterForDate 는 src/lib/semesterPhase.js 의 사본이다(functions 는 src/ 를 import 못 함).
// 4줄짜리 순수 함수 — 경계를 바꾸면 두 곳을 함께 고친다.
function semesterForDate(d = new Date()) {
  const m = d.getMonth() + 1;
  if (m >= 3 && m <= 7) return { year: d.getFullYear(), term: 1 };
  if (m >= 8) return { year: d.getFullYear(), term: 2 };
  return { year: d.getFullYear() - 1, term: 2 };
}

const key = (s) => s.year * 10 + s.term;

export const rolloverSemester = onSchedule(
  { schedule: '5 0 * * *', timeZone: 'Asia/Seoul' },
  async () => {
    const snap = await db.collection('semesters').get();
    const sems = snap.docs.map((d) => ({
      ref: d.ref,
      year: Number(d.get('year')),
      term: Number(d.get('term')),
      isCurrent: d.get('isCurrent') === true,
      hidden: d.get('hidden') === true,
    }));
    const visible = sems.filter((s) => !s.hidden);
    if (!visible.length) return;

    const impliedKey = key(semesterForDate(new Date()));
    const target = visible.find((s) => key(s) === impliedKey);
    if (!target || target.isCurrent) return;            // 날짜가 가리키는 학기가 없거나 이미 현재

    const flagged = visible.find((s) => s.isCurrent);
    if (flagged && key(flagged) >= impliedKey) return;  // 앞으로만 — 과거로 강등 안 함

    const batch = db.batch();
    for (const s of sems.filter((x) => x.isCurrent)) batch.update(s.ref, { isCurrent: false });
    batch.update(target.ref, { isCurrent: true, hidden: false });
    batch.update(db.doc('config/app'), { catalogVersion: FieldValue.increment(1) });
    await batch.commit();
  }
);
```

- [ ] **Step 2: `index.js` 에 export 추가**

Find the last line of `firebase/functions/index.js`:

```js
export { setNextClassAlerts, setTodaySummaryAlert, nextClassNotify } from './src/nextClass.js';
```

Add after it:

```js
export { setNextClassAlerts, setTodaySummaryAlert, nextClassNotify } from './src/nextClass.js';
export { rolloverSemester } from './src/semester.js';
```

- [ ] **Step 3: 문법 확인**

Run: `node --check firebase/functions/src/semester.js && node --check firebase/functions/index.js`
Expected: 출력 없음.

- [ ] **Step 4: 커밋**

```bash
git add firebase/functions/src/semester.js firebase/functions/index.js
git commit -m "feat: rolloverSemester — daily isCurrent backstop by calendar date

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: 관리자 UI — 학기 상태 라벨 + '수강계획으로 공개' 버튼

**Files:**
- Modify: `src/pages/Admin.jsx:1021-1042` (학기 Card)

**Interfaces:**
- Consumes: Task 2 `semesterPhase`, Task 5 `set_semester {hidden:false}`.

- [ ] **Step 1: `semesterPhase` import (Admin.jsx)**

Find [Admin.jsx:6](../../../src/pages/Admin.jsx#L6):

```js
import { getCatalog } from '../lib/cache';
```

Replace with:

```js
import { getCatalog, semesterPhase } from '../lib/cache';
```

- [ ] **Step 2: 학기 Card 교체**

Find [Admin.jsx:1023-1042](../../../src/pages/Admin.jsx#L1023):

```jsx
            <Card icon="🗓️" title="학기" desc="학기를 추가하거나 현재 학기를 지정합니다. 다음 학기를 미리 열려면 '학기 추가'만 하세요 — 생도가 그 학기 시간표를 미리 짤 수 있고, 현재 학기는 그대로 유지됩니다. ⚠️ 학기 삭제는 그 학기의 분반·강의시간과 생도들이 저장한 시간표까지 전부 지웁니다(되돌릴 수 없음).">
              <div className="adm-tags">
                {cat?.semesters?.length ? cat.semesters.map((s) => (
                  <span key={s.year + '' + s.term} className={`tag ${s.isCurrent ? 'tag-primary' : ''}`}>{s.year}-{s.term}{s.isCurrent ? ' (현재)' : ''}
                    <button className="x" title="이 학기 삭제 (분반·생도 시간표까지 연쇄 삭제)"
                      onClick={() => deleteSemester(s)}>×</button>
                  </span>
                )) : <span className="note">등록된 학기가 없습니다.</span>}
              </div>
              <div className="adm-form-grid">
                <label className="field"><span className="field-label">연도</span><input type="number" value={sem.year} onChange={(e) => setSem({ ...sem, year: +e.target.value })} /></label>
                <label className="field"><span className="field-label">학기</span>
                  <select value={sem.term} onChange={(e) => setSem({ ...sem, term: +e.target.value })}><option value={1}>1</option><option value={2}>2</option></select>
                </label>
              </div>
              <div className="adm-btn-row">
                <button className="btn-add" onClick={() => run('set_semester', { ...sem, isCurrent: false }, `${sem.year}-${sem.term} 학기 추가`)}>＋ 학기 추가</button>
                <button className="btn-ghost" onClick={() => run('set_semester', { ...sem, isCurrent: true }, '현재 학기 설정')}>현재 학기로 설정</button>
              </div>
            </Card>
```

Replace with:

```jsx
            <Card icon="🗓️" title="학기" desc="학기 추가 → 편람 입력 → '수강계획으로 공개'(생도가 미리 짤 수 있음) → 학기 시작일이 지나면 자동으로 현재 학기가 됩니다(수동 지정도 가능). 추가 직후에는 '숨김' 상태라 생도 화면에 안 뜹니다. ⚠️ 학기 삭제는 그 학기의 분반·강의시간과 생도들이 저장한 시간표까지 전부 지웁니다(되돌릴 수 없음).">
              <div className="adm-tags">
                {cat?.semesters?.length ? [...cat.semesters]
                  .sort((a, b) => b.year - a.year || b.term - a.term)
                  .map((s) => {
                    const phase = semesterPhase(cat, s.year, s.term);
                    const label = { hidden: '숨김', planning: '수강계획', current: '현재', past: '지난' }[phase];
                    return (
                      <span key={s.year + '' + s.term}
                        className={`tag ${phase === 'current' ? 'tag-primary' : ''} ${phase === 'hidden' ? 'tag-muted' : ''}`}>
                        {s.year}-{s.term} ({label})
                        {phase === 'hidden' && (
                          <button className="link-btn adm-sem-publish"
                            title="생도가 이 학기 시간표를 미리 짤 수 있게 공개"
                            onClick={() => run('set_semester', { year: s.year, term: s.term, hidden: false },
                              `${s.year}-${s.term} 수강계획으로 공개`)}>공개</button>
                        )}
                        <button className="x" title="이 학기 삭제 (분반·생도 시간표까지 연쇄 삭제)"
                          onClick={() => deleteSemester(s)}>×</button>
                      </span>
                    );
                  }) : <span className="note">등록된 학기가 없습니다.</span>}
              </div>
              <div className="adm-form-grid">
                <label className="field"><span className="field-label">연도</span><input type="number" value={sem.year} onChange={(e) => setSem({ ...sem, year: +e.target.value })} /></label>
                <label className="field"><span className="field-label">학기</span>
                  <select value={sem.term} onChange={(e) => setSem({ ...sem, term: +e.target.value })}><option value={1}>1</option><option value={2}>2</option></select>
                </label>
              </div>
              <div className="adm-btn-row">
                <button className="btn-add" onClick={() => run('set_semester', { ...sem, isCurrent: false }, `${sem.year}-${sem.term} 학기 추가(숨김)`)}>＋ 학기 추가</button>
                <button className="btn-ghost" onClick={() => run('set_semester', { ...sem, isCurrent: true }, '현재 학기 설정')}>현재 학기로 설정</button>
              </div>
            </Card>
```

- [ ] **Step 3: 라벨용 CSS (tag-muted, adm-sem-publish)**

`.tag` 계열은 `src/styles/base.css` 에 있다([base.css:334-345](../../../src/styles/base.css#L334)). `.tag .x:hover` 규칙 바로 아래에 추가(색은 토큰):

```css
/* 학기 태그 — 숨김 상태(관리자 편람 입력 중, 생도 미노출) */
.tag.tag-muted { opacity: 0.65; border: 1px dashed var(--border); }
.adm-sem-publish { margin-left: 0.35rem; font-size: 0.72rem; color: var(--accent); }
```

- [ ] **Step 4: 빌드 + 커밋**

```bash
npm run build          # 성공 확인
git add src/pages/Admin.jsx src/styles/base.css
git commit -m "feat: admin semester card shows phase (숨김/수강계획/현재/지난) + publish button

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: 홈 — 지난 학기 → 현재 학기 유도 배너 + 수강계획 넛지

**Files:**
- Modify: `src/pages/Home.jsx` (import, 파생값, 배너 핸들러, 렌더)
- Modify: `src/styles/home.css` (배너 스타일)

**Interfaces:**
- Consumes: Task 2 `currentSemester`/`semesterList`, Task 4 `handleCreate`/`handleSelect`, `clearDraft`/`readDraft`.

- [ ] **Step 1: import 에 `clearDraft` 추가**

Find [Home.jsx:21](../../../src/pages/Home.jsx#L21):

```js
import { buildSeed, seedDraft, readDraft } from '../lib/wizardDraft';
```

Replace with:

```js
import { buildSeed, seedDraft, readDraft, clearDraft } from '../lib/wizardDraft';
```

- [ ] **Step 2: 파생값 추가**

`src/pages/Home.jsx` 의 `semesters` useMemo ([Home.jsx:102](../../../src/pages/Home.jsx#L102)) 아래에 추가:

```js
  const current = useMemo(() => (catalog ? currentSemester(catalog) : null), [catalog]);
  const curKey = current ? current.year * 10 + current.term : 0;
  // 선택한 시간표가 현재보다 지난 학기인가 → 앞으로 유도 배너
  const isStale = !!(selected && curKey && (selected.year * 10 + selected.term) < curKey);
  // 현재 학기 확정본이 이미 있나(있으면 배너는 '전환'만, 없으면 '만들기')
  const currentPrimary = useMemo(
    () => (current ? timetables.find((t) => t.year === current.year && t.term === current.term && t.isPrimary) : null),
    [timetables, current]
  );
  // 수강계획(공개된 미래) 학기 중 내 시간표가 하나도 없는 것 — 약한 넛지
  const planningSem = useMemo(() => {
    if (!catalog || !curKey) return null;
    return semesterList(catalog)
      .filter((s) => s.year * 10 + s.term > curKey)
      .find((s) => !timetables.some((t) => t.year === s.year && t.term === s.term)) ?? null;
  }, [catalog, curKey, timetables]);
```

(`currentSemester`·`semesterList` 은 이미 [Home.jsx:12](../../../src/pages/Home.jsx#L12) 에서 import 됨.)

- [ ] **Step 3: 배너 액션 핸들러**

`openWizardFix` ([Home.jsx:118](../../../src/pages/Home.jsx#L118)) 근처에 추가. 마법사는 초안이 없으면 `currentSemester`(이제 날짜 인식 = 26-2)로 시작하므로 시드가 필요 없다 — 짜던 초안만 정리한다:

```js
  // 지난 학기에 있을 때 새 학기 시간표를 마법사로 짜러 간다.
  // 마법사는 초안이 없으면 currentSemester(날짜 인식)로 열리므로 시드 불필요 — 스테일 초안만 정리.
  const startNewSemesterWizard = useCallback(() => {
    if (readDraft(uid) && !confirm('마법사에 짜던 초안이 있습니다.\n새 학기로 새로 시작할까요?')) return;
    clearDraft();
    navigate('/wizard');
  }, [uid, navigate]);
```

- [ ] **Step 4: 배너 렌더**

Find the conflicts 배너 블록 ([Home.jsx:421-431](../../../src/pages/Home.jsx#L421)). **그 앞에** 삽입:

```jsx
          {isStale && (
            <div className="tt-sem-banner" role="status">
              <p className="tt-sem-banner-t">
                📅 지금은 <strong>{current.year}-{current.term}학기</strong>입니다.
                {selected.name ? ` '${selected.name}'은(는) ` : ' 지금 보는 건 '}지난 학기 시간표예요.
              </p>
              <div className="tt-sem-banner-actions">
                {currentPrimary ? (
                  <button className="btn-add btn-sm" onClick={() => handleSelect(currentPrimary.id)}>
                    {current.year}-{current.term} 시간표로
                  </button>
                ) : (
                  <>
                    <button className="btn-add btn-sm" onClick={startNewSemesterWizard}>🪄 마법사로 짜기</button>
                    <button className="btn-ghost btn-sm"
                      onClick={() => handleCreate({ year: current.year, term: current.term, name: '내 시간표' })}>
                      빈 시간표
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
```

Find the 초안 안내 블록 ([Home.jsx:455-459](../../../src/pages/Home.jsx#L455)). **그 뒤에** 삽입(수강계획 넛지):

```jsx
          {planningSem && !isStale && (
            <p className="tt-draft-note">
              📖 {planningSem.year}-{planningSem.term}학기 수강 계획을 미리 시작할 수 있어요.
              {' '}
              <button type="button" className="link-btn"
                onClick={() => handleCreate({ year: planningSem.year, term: planningSem.term, name: '수강 계획' })}>
                {planningSem.year}-{planningSem.term} 시간표 만들기
              </button>
            </p>
          )}
```

- [ ] **Step 5: 배너 CSS**

`src/styles/home.css` 의 `.tt-conflict-warn` 블록([home.css:305](../../../src/styles/home.css#L305)) 앞에 추가:

```css
/* 새 학기가 시작됐는데 지난 학기 시간표를 보고 있을 때의 유도 배너(정보 톤 — 경고 아님) */
.tt-sem-banner {
  margin: 0 0.65rem 0.7rem;
  padding: 0.7rem 0.8rem;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface);
}
.tt-sem-banner-t {
  margin: 0 0 0.5rem;
  font-size: 0.82rem;
  color: var(--text-1);
  line-height: 1.45;
}
.tt-sem-banner-actions {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}
```

- [ ] **Step 6: 빌드 + 커밋**

```bash
npm run build          # 성공 확인
git add src/pages/Home.jsx src/styles/home.css
git commit -m "feat: home banner nudges from a past-semester timetable to the current one

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: 강의 검색 — 검색 중인 학기 명시 + 지난/수강계획 경고

**Files:**
- Modify: `src/pages/CourseSearch.jsx` (검색 대상 학기 파생 + 안내 배너)

**Interfaces:**
- Consumes: Task 2 `semesterPhase`, `currentSemester` (Task 4 에서 import 됨), Task 4 `changeTarget`.

- [ ] **Step 1: `semesterPhase` import + 검색 대상 학기·상태 파생**

Task 4 에서 바꾼 cache import 줄에 `semesterPhase` 를 더한다:

```js
import { getCatalog, subscribeCatalog, buildSections, formatTimes, currentSemester } from '../lib/cache';
```

→

```js
import { getCatalog, subscribeCatalog, buildSections, formatTimes, currentSemester, semesterPhase } from '../lib/cache';
```

`sections` useMemo ([CourseSearch.jsx:40-43](../../../src/pages/CourseSearch.jsx#L40)) 아래에 추가:

```js
  // 검색 중인 학기 = 담을 시간표의 학기. 그 학기의 상태로 안내를 가른다.
  const searchPhase = useMemo(
    () => (catalog && target ? semesterPhase(catalog, target.year, target.term) : null),
    [catalog, target]
  );
  const current = useMemo(() => (catalog ? currentSemester(catalog) : null), [catalog]);
  const currentPrimary = useMemo(
    () => (current ? timetables.find((t) => t.year === current.year && t.term === current.term && t.isPrimary) : null),
    [timetables, current]
  );
```

- [ ] **Step 2: 안내 배너 렌더**

Find the `cor-notice` 안내 문단 ([CourseSearch.jsx:225-229](../../../src/pages/CourseSearch.jsx#L225)). **그 앞에** 삽입:

```jsx
      {target && (
        <p className="cs-sem-note">
          <strong>{target.year}-{target.term}학기</strong> 강의를 검색 중입니다.
          {searchPhase === 'past' && (
            <>
              {' '}지난 학기예요.
              {currentPrimary
                ? <button type="button" className="link-btn" onClick={() => changeTarget(currentPrimary.id)}>
                    {current.year}-{current.term}로 전환
                  </button>
                : <> 현재 학기 시간표는 홈에서 만들 수 있어요.</>}
            </>
          )}
          {searchPhase === 'planning' && ' 아직 확정 전이라 시간·강의실·교수가 바뀔 수 있어요.'}
        </p>
      )}
```

- [ ] **Step 3: CSS**

`src/styles/course.css` 끝에 추가:

```css
.cs-sem-note {
  margin: 0 0 0.6rem;
  font-size: 0.8rem;
  color: var(--text-2);
  line-height: 1.5;
}
.cs-sem-note .link-btn { margin-left: 0.3rem; }
```

- [ ] **Step 4: 빌드 + 커밋**

```bash
npm run build          # 성공 확인
git add src/pages/CourseSearch.jsx src/styles/course.css
git commit -m "feat: course search states which semester it searches, warns on past/planning

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: 마법사 — 수강계획 학기 '확정 전' 경고

숨김 학기 제외는 Task 2 의 `semesterList` 필터로 이미 적용됨([Wizard.jsx:227](../../../src/pages/Wizard.jsx#L227)). 여기선 경고만.

**Files:**
- Modify: `src/pages/Wizard.jsx` (1단계 학기 선택 아래 경고)

**Interfaces:**
- Consumes: Task 2 `semesterPhase`.

- [ ] **Step 1: `semesterPhase` import + 파생**

Find [Wizard.jsx:7](../../../src/pages/Wizard.jsx#L7):

```js
import { getCatalog, buildSections, currentSemester, semesterList, formatTimes, dayLabel } from '../lib/cache';
```

Replace with:

```js
import { getCatalog, buildSections, currentSemester, semesterList, semesterPhase, formatTimes, dayLabel } from '../lib/cache';
```

`sem` useMemo ([Wizard.jsx:228-231](../../../src/pages/Wizard.jsx#L228)) 아래에 추가:

```js
  const semPhase = useMemo(
    () => (catalog && sem ? semesterPhase(catalog, sem.year, sem.term) : null),
    [catalog, sem]
  );
```

- [ ] **Step 2: 경고 렌더**

Find the 1단계 학기 `<label className="field wz-sem">` 블록 끝([Wizard.jsx:730](../../../src/pages/Wizard.jsx#L730), `</label>` 직후):

```jsx
            </label>
            <p className="wz-lead">들어야 하는 과목을 모두 담으세요. 분반은 다음 단계에서 고릅니다.</p>
```

Replace with:

```jsx
            </label>
            {semPhase === 'planning' && (
              <p className="wz-warn">⚠️ {sem.year}-{sem.term}학기는 아직 확정 전입니다 — 편람 조정 중이라 시간·강의실·교수가 바뀔 수 있어요.</p>
            )}
            <p className="wz-lead">들어야 하는 과목을 모두 담으세요. 분반은 다음 단계에서 고릅니다.</p>
```

(`.wz-warn` 는 이미 존재 — [Wizard.jsx:711](../../../src/pages/Wizard.jsx#L711) 에서 사용 중.)

- [ ] **Step 3: 빌드 + 커밋**

```bash
npm run build          # 성공 확인
git add src/pages/Wizard.jsx
git commit -m "feat: wizard warns when the chosen semester is still in planning (확정 전)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: 빈 강의실 — 공유 `currentSemester` 사용

**Files:**
- Modify: `src/pages/EmptyRooms.jsx:50-57`

- [ ] **Step 1: 인라인 계산을 헬퍼로 교체**

Find [EmptyRooms.jsx:51-57](../../../src/pages/EmptyRooms.jsx#L51):

```js
  const model = useMemo(() => {
    if (!catalog) return null;
    const semesters = catalog.semesters ?? [];
    const current =
      semesters.find((s) => s.isCurrent) ??
      [...semesters].sort((a, b) => b.year - a.year || b.term - a.term)[0];
    if (!current) return { current: null };
```

Replace with:

```js
  const model = useMemo(() => {
    if (!catalog) return null;
    const current = currentSemester(catalog);
    if (!current) return { current: null };
```

Also update the cache import [EmptyRooms.jsx:3](../../../src/pages/EmptyRooms.jsx#L3):

```js
import { getCatalog, subscribeCatalog, dayLabel } from '../lib/cache';
```

→

```js
import { getCatalog, subscribeCatalog, dayLabel, currentSemester } from '../lib/cache';
```

- [ ] **Step 2: 빌드 + 커밋**

```bash
npm run build          # 성공 확인
git add src/pages/EmptyRooms.jsx
git commit -m "refactor: EmptyRooms uses the shared date-aware currentSemester

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 12: 계산기 — 성적 학기 선택을 편람에서 분리

**Files:**
- Modify: `src/pages/Calc.jsx` — `GpaTab({ catalog, uid })` 컴포넌트([Calc.jsx:32](../../../src/pages/Calc.jsx#L32))의 `semesters` useMemo + 학기 `<select>` + `＋ 다른 학기`. import 정리.

**Interfaces:**
- Consumes: Task 2 `currentSemester`, `semesterForDate`.

- [ ] **Step 1: import 정리**

Find [Calc.jsx:4](../../../src/pages/Calc.jsx#L4):

```js
import { getCatalog, currentSemester, semesterList, buildMyTimetable } from '../lib/cache';
```

Replace with:

```js
import { getCatalog, currentSemester, semesterForDate, buildMyTimetable } from '../lib/cache';
```

(`semesterList` 제거 — 성적 학기는 편람과 무관.)

- [ ] **Step 2: 수동 학기 로컬 상태 + localStorage**

`GpaTab` 안, `sem` state 선언([Calc.jsx:35](../../../src/pages/Calc.jsx#L35)) 바로 아래에 추가:

```js
  const MANUAL_SEMS_KEY = `calc:manualSems:${uid || 'anon'}`;
  const [manualSems, setManualSems] = useState(() => {
    try { return JSON.parse(localStorage.getItem(MANUAL_SEMS_KEY) || '[]'); } catch { return []; }
  });
  const addManualSem = useCallback(() => {
    const y = Number(prompt('연도 (예: 2023)'));
    if (!Number.isInteger(y) || y < 2000 || y > 2100) return;
    const t = Number(prompt('학기 (1 또는 2)'));
    if (t !== 1 && t !== 2) return;
    setManualSems((prev) => {
      if (prev.some((s) => s.year === y && s.term === t)) return prev;
      const next = [...prev, { year: y, term: t }];
      try { localStorage.setItem(MANUAL_SEMS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, [MANUAL_SEMS_KEY]);
```

(`useCallback`·`useState` 는 [Calc.jsx:1](../../../src/pages/Calc.jsx#L1) 에서 이미 import 됨 — 확인만.)

- [ ] **Step 3: `semesters` useMemo 교체**

Find [Calc.jsx:61-67](../../../src/pages/Calc.jsx#L61):

```js
  // 학기 후보: 편람 학기 ∪ 내 성적행의 학기.
  const semesters = useMemo(() => {
    const map = new Map();
    for (const s of (catalog ? semesterList(catalog) : [])) map.set(`${s.year}-${s.term}`, { year: s.year, term: s.term });
    for (const r of (rows ?? [])) map.set(`${r.year}-${r.term}`, { year: r.year, term: r.term });
    return [...map.values()].sort((a, b) => b.year - a.year || b.term - a.term);
  }, [catalog, rows]);
```

Replace with:

```js
  // 학기 후보: 편람과 무관한 개인 기록이므로(스키마 주석) 생성 범위(현재~4년 전) ∪
  // 내 성적행 ∪ '＋ 다른 학기'로 직접 넣은 것. 편람의 숨김·미래 학기는 여기 안 나온다.
  const semesters = useMemo(() => {
    const map = new Map();
    const cur = (catalog ? currentSemester(catalog) : null) ?? semesterForDate();
    for (let y = cur.year; y >= cur.year - 4; y--) {
      for (const t of [2, 1]) {
        if (y < cur.year || t <= cur.term) map.set(`${y}-${t}`, { year: y, term: t });
      }
    }
    for (const r of (rows ?? [])) map.set(`${r.year}-${r.term}`, { year: r.year, term: r.term });
    for (const m of manualSems) map.set(`${m.year}-${m.term}`, { year: m.year, term: m.term });
    return [...map.values()].sort((a, b) => b.year - a.year || b.term - a.term);
  }, [catalog, rows, manualSems]);
```

- [ ] **Step 4: 학기 `<select>` 옆에 '＋ 다른 학기' 버튼**

Find [Calc.jsx:151-165](../../../src/pages/Calc.jsx#L151) (`calc-sem-row`):

```jsx
      <div className="calc-sem-row">
        <label className="calc-sem-label">학기</label>
        <select
          className="calc-sem-select"
          value={sem ? `${sem.year}-${sem.term}` : ''}
          onChange={(e) => {
            const [y, t] = e.target.value.split('-').map(Number);
            setSem({ year: y, term: t });
          }}
        >
          {semesters.length === 0 && <option value="">학기 없음</option>}
          {semesters.map((s) => (
            <option key={`${s.year}-${s.term}`} value={`${s.year}-${s.term}`}>{s.year}년 {s.term}학기</option>
          ))}
        </select>
      </div>
```

Replace with:

```jsx
      <div className="calc-sem-row">
        <label className="calc-sem-label">학기</label>
        <select
          className="calc-sem-select"
          value={sem ? `${sem.year}-${sem.term}` : ''}
          onChange={(e) => {
            const [y, t] = e.target.value.split('-').map(Number);
            setSem({ year: y, term: t });
          }}
        >
          {semesters.length === 0 && <option value="">학기 없음</option>}
          {semesters.map((s) => (
            <option key={`${s.year}-${s.term}`} value={`${s.year}-${s.term}`}>{s.year}년 {s.term}학기</option>
          ))}
        </select>
        <button type="button" className="link-btn calc-sem-add" onClick={addManualSem}>＋ 다른 학기</button>
      </div>
```

- [ ] **Step 5: CSS**

`.calc-sem-row` 는 `src/styles/calc.css:23-25`. `.calc-sem-select` 규칙 아래에 추가:

```css
.calc-sem-add { margin-left: 0.5rem; font-size: 0.78rem; flex: 0 0 auto; }
```

- [ ] **Step 6: 빌드 + 커밋**

```bash
npm run build          # 성공 확인
git add src/pages/Calc.jsx src/styles/calc.css
git commit -m "feat: grade calculator semester choice decoupled from the course catalog

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 13: 통합 검증 + 배포

**Files:** 없음 (검증·배포만)

- [ ] **Step 1: 전체 빌드**

Run: `npm run build`
Expected: 성공, 경고 없음(있으면 해당 Task 로 돌아가 수정).

- [ ] **Step 2: functions 문법 일괄 확인**

Run: `node --check firebase/functions/index.js && node --check firebase/functions/src/semester.js && node --check firebase/functions/src/admin/catalogActions.js`
Expected: 출력 없음.

- [ ] **Step 3: 로컬 미리보기 스모크 체크(선택, 가능하면)**

Run: `npm run preview` 후 브라우저로 홈 진입 — 콘솔 에러 없음, 시간표 격자 렌더, 배너 로직이 (지난 학기 시간표만 있으면) 뜨는지 눈으로 확인. `Ctrl+C`.

- [ ] **Step 4: 배포**

```bash
git status              # 클린 확인 (모든 Task 커밋됨)
git push origin main
```

푸시 후:
- **Firebase**: `firebase/**` 변경(`catalogActions.js`, `semester.js`, `index.js`)이 있으므로 `deploy-firebase.yml` 이 돈다. GitHub Actions 탭에서 성공 확인. `rolloverSemester`(새 스케줄 함수) 생성 로그 확인.
- **Cloudflare Pages**: 같은 push 에 프론트 자동 재빌드. Pages 대시보드에서 배포 성공 확인.

- [ ] **Step 5: 배포 후 실기기 확인**

1. **갇힌 사용자 해소**: 26-1 확정 시간표만 있고 26-2 시간표가 없는 계정으로 앱 진입 → 홈 상단에 "📅 지금은 26-2학기입니다" 배너 + [🪄 마법사로 짜기]/[빈 시간표]. [빈 시간표] → 26-2 빈 격자로 전환, 배너 사라짐.
2. **강의 검색**: 담을 시간표가 26-1이면 "26-1학기 강의를 검색 중입니다 · 지난 학기예요 · [26-2로 전환]". 전환 누르면 26-2 분반이 조립됨.
3. **관리자**: 관리자 계정 → 학기 카드에 26-1(지난)/26-2(현재) 라벨. 임의의 미래 학기 추가 → "(숨김)" + [공개] 버튼. [공개] → "(수강계획)"으로 바뀌고, 일반 계정 마법사 학기 드롭다운에 등장 + "확정 전" 경고.
4. **계산기**: 학기 드롭다운에 편람 미래·숨김 학기가 안 뜨고 현재~4년 전 범위만. [＋ 다른 학기]로 2019-1 추가 → 드롭다운에 나타남, 새로고침 후에도 유지.
5. **날짜 백스톱**(로그만): 다음 날 `rolloverSemester` 실행 로그에 에러 없음(26-2가 이미 current 라 no-op).

- [ ] **Step 6: 스펙 갱신**

`docs/superpowers/specs/2026-09-03-semester-lifecycle-and-orientation-design.md` 하단에 한 줄:

```markdown
## 구현

2026-09-03 구현·배포 완료. 계획: `docs/superpowers/plans/2026-09-03-semester-lifecycle-and-orientation.md`. 후속 Ⅶ(앱 리포트 회신)은 별도 스펙으로.
```

```bash
git add docs/superpowers/specs/2026-09-03-semester-lifecycle-and-orientation-design.md
git commit -m "docs: mark semester-lifecycle spec implemented

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git push origin main
```

---

## Self-Review

**Spec coverage:**

| 스펙 항목 | Task |
|---|---|
| Ⅰ 데이터 모델(`hidden`) | 5 (ensureSemester), 5 (setSemester) |
| Ⅰ `currentSemester` 날짜 인식 | 1, 2 |
| Ⅰ 백엔드 날짜 백스톱 | 6 |
| Ⅰ 관리자 UI 3버튼 + 라벨 | 7 |
| Ⅰ 마이그레이션(백필 불필요) | Global Constraints + 5 |
| Ⅱ.1 `pickTimetable` 유예 창 | 3, 4 |
| Ⅱ.2 홈 배너 | 8 |
| Ⅱ.3 수강계획 넛지 | 8 |
| Ⅱ.4 강의 검색 학기 명시·경고 | 4, 9 |
| Ⅱ.5 마법사 숨김 제외 + 경고 | 2 (필터), 10 (경고) |
| Ⅱ.6 `semesterList` 숨김 필터 | 2 |
| Ⅱ.7 EmptyRooms 공유 헬퍼 | 11 |
| Ⅲ 성적 학기 분리 + ＋다른 학기 | 12 |
| Ⅴ 테스트(스크래치·빌드·수동) | 1, 3, 13 |

빠진 항목 없음. 앱 리포트 회신(Ⅶ)은 스펙에서 명시적으로 별도 스펙 — 이 계획 범위 밖.

**Placeholder scan:** 코드 스텝은 모두 실제 코드. Task 7 Step 1·Task 11·Task 12 Step 5 는 "기존 import 목록에 X 추가"·"grep 으로 CSS 파일 찾기"처럼 파일별 사소한 확인이 필요한 지점을 명시했고, 그 외 붙여넣을 코드는 전부 완전하다.

**Type consistency:**
- `semesterForDate() → {year, term}` — Task 1 정의, Task 6(사본)·12 에서 사용, 모양 일치.
- `resolveCurrentSemester(semesters, now)` — Task 1, `currentSemester(catalog, now)` 가 `catalog.semesters` 를 넘김(Task 2). 일치.
- `semesterPhaseOf(semesters, y, t, now)` (Task 1) vs `semesterPhase(catalog, y, t, now)` (Task 2 래퍼) — 래퍼가 `catalog.semesters` 를 품. Task 7·9·10 은 `semesterPhase(catalog, …)` 사용. 일치.
- `honorsPreferred(preferred, current, preferredAt, now)` — Task 1 정의, Task 3 `pickTimetable` 이 `(byId, current, preferredAt, Date.now())` 로 호출. `byId`·`current` 둘 다 `{year, term}` 보유(timetable row, semester). 일치.
- `pickTimetable(list, current, preferredId, preferredAt)` — Task 3 정의, Task 4 의 5개 호출부 모두 4인자. 일치.
- `selectTimetable(id)` / `readSelectedAt()` — Task 3 정의, Task 4 에서 Home·CourseSearch·Wizard 가 사용. 일치.
- `set_semester` 페이로드 `{year, term, hidden:false}` — Task 5 처리, Task 7 버튼이 송신. 일치.
