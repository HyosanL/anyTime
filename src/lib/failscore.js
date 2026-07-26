// =====================================================================
//  과락점수계산기 — 순수 계산 + 로컬 저장(localStorage)
//
//  한 과목의 최종 원점수(원점수합)는 각 평가의 '점수 × 반영비율/100' 을 더한 값이다.
//  이 값이 과락기준(기본 60) 미만이면 과락. 아직 안 본 평가(빈 칸)에 대해,
//  과락을 면하려면 최소 몇 점이 필요한지 되짚어 보여 준다.
//
//  핵심: 남은 목표(remaining)를 빈 칸들에 '반영비율대로' 나눠 준다.
//    - 빈 칸이 보여 주는 값 = 그 칸이 채워야 할 '가중 기여분'(원점수합에 더해지는 몫).
//    - 비율대로 나누므로 모든 빈 칸의 '필요 원점수'는 서로 같다(neededRaw).
//  예) 30:30:40, 전부 빈칸, 기준 60 → 18·18·24(기여분), 각 칸 필요 원점수 60.
//      수시 100 입력 → 100·12.9·17.1, 필요 원점수 ≈ 42.9.
//      이어 중간 100 → 100·100·0, 남은 것 없음.
//
//  서버 저장이 아니라 로컬(기기)만 쓴다 — 학기 중 즉석 계산용이고 쓰기·egress 0.
// =====================================================================

export const EVAL_KEYS = ['수시', '중간', '기말'];
export const DEFAULT_RATIOS = { 수시: 30, 중간: 30, 기말: 40 };
export const DEFAULT_THRESHOLD = 60;
export const DEFAULT_WARN = 80;

// 소수 한 자리 반올림(표시·저장 공통). NaN 은 null 로.
export function round1(n) {
  if (n == null || Number.isNaN(n)) return null;
  return Math.round(n * 10) / 10;
}

// 값이 '입력됨'인지 — 0 도 입력이다(null/'' 만 미입력).
function isEntered(v) {
  return v != null && v !== '' && !Number.isNaN(Number(v));
}

// 한 과목의 계산 결과.
//   evals: [{ key, ratio, score(null|number) }], threshold: number
// 반환:
//   evals: 입력칸별 { key, ratio, entered, display, neededRaw, impossible }
//   enteredContribution / remaining / neededRaw / hasBlank / secured / ratioSum
export function computeCourse(course) {
  const threshold = Number(course.threshold ?? DEFAULT_THRESHOLD) || 0;
  const evals = course.evals ?? [];

  let enteredContribution = 0;
  let blankRatioSum = 0;
  for (const ev of evals) {
    const ratio = Number(ev.ratio) || 0;
    if (isEntered(ev.score)) enteredContribution += Number(ev.score) * ratio / 100;
    else blankRatioSum += ratio;
  }

  const remaining = Math.max(0, threshold - enteredContribution);
  // 비율대로 나눌 때 모든 빈 칸의 필요 원점수는 동일하다.
  const neededRaw = blankRatioSum > 0 ? (remaining * 100) / blankRatioSum : 0;

  const out = evals.map((ev) => {
    const ratio = Number(ev.ratio) || 0;
    if (isEntered(ev.score)) {
      const raw = Number(ev.score);
      return { key: ev.key, ratio, entered: true, display: round1(raw), raw, neededRaw: null, impossible: false };
    }
    // 빈 칸: 이 칸이 채워야 할 가중 기여분(비율 몫). 원점수합이 기준에 닿게 하는 최소.
    const contribution = blankRatioSum > 0 ? (remaining * ratio) / blankRatioSum : 0;
    return {
      key: ev.key,
      ratio,
      entered: false,
      display: round1(contribution),
      raw: null,
      neededRaw: round1(neededRaw),
      impossible: neededRaw > 100,
    };
  });

  const ratioSum = evals.reduce((s, ev) => s + (Number(ev.ratio) || 0), 0);
  const hasBlank = blankRatioSum > 0;

  return {
    evals: out,
    threshold,
    enteredContribution: round1(enteredContribution),
    remaining: round1(remaining),
    neededRaw: round1(neededRaw),
    hasBlank,
    impossible: hasBlank && neededRaw > 100,
    secured: enteredContribution,   // 정렬 키(반올림 전 원값)
    ratioSum,
  };
}

// 경고: 아직 안 본 평가가 있고, 그 필요 원점수가 슬라이더값을 넘으면 위험 과목.
export function isWarn(computed, warnThreshold) {
  return computed.hasBlank && computed.neededRaw != null && computed.neededRaw > Number(warnThreshold);
}

// 정렬: 확보 기여분 오름차순(적을수록 위험 → 위로), 동률은 이름순.
export function sortCourses(courses) {
  return [...courses].sort((a, b) => {
    const sa = computeCourse(a).secured;
    const sb = computeCourse(b).secured;
    if (sa !== sb) return sa - sb;
    return (a.name || '').localeCompare(b.name || '', 'ko');
  });
}

// ── 로컬 저장 ─────────────────────────────────────────────────────────
const KEY = (uid) => `anytime.failscore.${uid || 'anon'}`;

function newId() {
  // 앱 런타임 — crypto 우선, 없으면 시각+난수.
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `c_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function makeCourse(name) {
  return {
    id: newId(),
    name: (name || '').trim(),
    threshold: DEFAULT_THRESHOLD,
    evals: EVAL_KEYS.map((key) => ({ key, ratio: DEFAULT_RATIOS[key], score: null })),
  };
}

export function loadState(uid) {
  try {
    const raw = localStorage.getItem(KEY(uid));
    if (!raw) return { warnThreshold: DEFAULT_WARN, courses: [] };
    const parsed = JSON.parse(raw);
    return {
      warnThreshold: parsed.warnThreshold ?? DEFAULT_WARN,
      courses: Array.isArray(parsed.courses) ? parsed.courses : [],
    };
  } catch {
    return { warnThreshold: DEFAULT_WARN, courses: [] };
  }
}

export function saveState(uid, state) {
  try { localStorage.setItem(KEY(uid), JSON.stringify(state)); } catch { /* 저장 실패 무시 */ }
}

// 시간표 과목명으로 시드/병합 — 이미 있는 이름은 건너뛴다(로컬 편집 보존).
export function mergeCourses(existing, names) {
  const have = new Set(existing.map((c) => (c.name || '').trim()));
  const added = names
    .map((n) => (n || '').trim())
    .filter((n) => n && !have.has(n))
    .map((n) => makeCourse(n));
  return [...existing, ...added];
}
