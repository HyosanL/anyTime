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
