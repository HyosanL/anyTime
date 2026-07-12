// =====================================================================
//  시간표 마법사 — 조합 생성기 (순수 계산. 서버 접근 없음)
//
//  들어야 하는 과목을 담고 과목마다 '가능한 분반'만 켜 두면,
//  그 분반들로 만들 수 있는 겹치지 않는 시간표를 모두 찾아 점수 순으로 돌려준다.
//
//  ★ 핵심 규칙 — 후보에 등장하는 분반은 사용자가 켠 분반뿐이다.
//    (항공기상에서 1분반만 켰다면 2·3분반은 어떤 후보에도 들어가지 않는다.
//     생성기는 allowed 밖의 분반을 애초에 입력으로 받지 않는다.)
//
//  카탈로그(과목·분반·강의시간)는 이미 IndexedDB 에 있다 → 계산은 전부 브라우저에서.
//  서버는 '저장'을 누를 때만 건드린다(= 마법사가 서버 부하를 늘리지 않는 이유).
// =====================================================================

const MAX_PERIOD = 30;          // 비트마스크 한 칸(32bit int)에 담는 교시 상한
const NODE_LIMIT = 300000;      // 탐색 노드 상한(분반을 안 좁힌 채 돌려도 브라우저가 안 멈추게)
const COMBO_LIMIT = 2000;       // 검토할 조합 상한(이 안에서 점수 매겨 상위를 보여준다)

// 요일(1~7) × 교시 → 비트마스크. mask[day] 의 p번 비트 = 그 요일 p교시 사용중.
export function timeMask(times) {
  const m = new Int32Array(8);
  for (const t of times ?? []) {
    const d = t.day_of_week;
    if (!(d >= 1 && d <= 7)) continue;
    const s = Math.max(1, t.start_period);
    const e = Math.min(MAX_PERIOD, t.end_period);
    for (let p = s; p <= e; p++) m[d] |= 1 << p;
  }
  return m;
}

// 기피 시간 격자(Set of "요일-교시") → 마스크
export function blockedMask(blocked) {
  const m = new Int32Array(8);
  for (const key of blocked ?? []) {
    const [d, p] = String(key).split('-').map(Number);
    if (d >= 1 && d <= 7 && p >= 1 && p <= MAX_PERIOD) m[d] |= 1 << p;
  }
  return m;
}

function overlaps(a, b) {
  for (let d = 1; d <= 7; d++) if (a[d] & b[d]) return true;
  return false;
}
function merged(a, b) {
  const m = new Int32Array(8);
  for (let d = 1; d <= 7; d++) m[d] = a[d] | b[d];
  return m;
}
const isEmptyMask = (m) => {
  for (let d = 1; d <= 7; d++) if (m[d]) return false;
  return true;
};

// 한 후보의 성격 — 공강 요일 / 1교시 횟수 / 빈 교시(공강교시) 수
export function comboStats(sections, periodNos) {
  const m = new Int32Array(8);
  for (const s of sections) {
    const sm = timeMask(s.times);
    for (let d = 1; d <= 7; d++) m[d] |= sm[d];
  }
  const firstPeriod = periodNos[0] ?? 1;
  const freeDays = [];
  let early = 0;
  let gaps = 0;
  let dayCount = 0;

  for (let d = 1; d <= 7; d++) {
    if (!m[d]) {
      if (d >= 1 && d <= 5) freeDays.push(d);   // 공강은 평일만 센다(주말은 원래 비어 있다)
      continue;
    }
    dayCount++;
    if (m[d] & (1 << firstPeriod)) early++;
    // 그날 첫 교시~마지막 교시 사이에 비어 있는 교시 = 학교에 붙잡혀 있는 빈 시간
    const used = periodNos.filter((p) => m[d] & (1 << p));
    const first = used[0];
    const last = used[used.length - 1];
    const span = periodNos.filter((p) => p >= first && p <= last).length;
    gaps += span - used.length;
  }
  // 시간 미정(강의시간이 없는) 분반은 격자에 못 올린다 — 후보 카드에 표시해 준다.
  const unscheduled = sections.filter((s) => !(s.times?.length)).length;
  return { freeDays, early, gaps, dayCount, unscheduled };
}

// 정렬: 무엇을 먼저 볼 것인가. (동점이면 나머지 지표로 차례차례 가른다)
export const SORTS = {
  free:  { label: '공강일 많은 순',        key: (x) => [-x.stats.freeDays.length, x.stats.gaps, x.stats.early] },
  early: { label: '1교시 적은 순',         key: (x) => [x.stats.early, -x.stats.freeDays.length, x.stats.gaps] },
  gap:   { label: '빈 시간(공강교시) 적은 순', key: (x) => [x.stats.gaps, -x.stats.freeDays.length, x.stats.early] },
};

// 정렬만 다시 한다 — 정렬 기준을 바꿨다고 조합을 다시 만들 이유는 없다(조합 집합은 그대로다).
export function sortCombos(combos, mode = 'free') {
  const key = (SORTS[mode] ?? SORTS.free).key;
  return [...combos].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0;   // 동점이면 항상 같은 순서(안정)
  });
}

// 두 과목이 '고른 분반으로는 절대 함께 못 듣는' 사이인지 — 조합이 0개일 때 이유를 알려주려고.
function conflictPairs(prepared) {
  const out = [];
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const ok = prepared[i].options.some((a) =>
        prepared[j].options.some((b) => !overlaps(a.mask, b.mask))
      );
      if (!ok) out.push([prepared[i].name, prepared[j].name]);
    }
  }
  return out;
}

/**
 * 겹치지 않는 시간표 조합을 모두 찾는다.
 *
 * @param courses  [{ code, name, options: Section[] }]  options = 사용자가 켠 분반만
 * @param blocked  Set<"요일-교시">  피하고 싶은 시간(그 시간을 쓰는 분반은 후보에서 제외)
 * @param periodNos 교시 번호 오름차순 (빈 시간 계산용)
 * @returns { combos, truncated, blockedOut, impossible, pairs }
 *   combos     : [{ sections, stats, sig }]  정렬 전(순서는 sortCombos 가 정한다)
 *   blockedOut : 기피 시간 때문에 빠진 분반 수(과목별)
 *   impossible : 기피 시간 때문에 남은 분반이 0개가 된 과목명
 */
export function generateCombos({ courses, blocked, periodNos }) {
  const bm = blockedMask(blocked);

  // 1) 기피 시간과 겹치는 분반을 먼저 걷어낸다.
  const prepared = courses.map((c) => {
    const all = (c.options ?? []).map((s) => ({ s, mask: timeMask(s.times) }));
    const options = all.filter(({ mask }) => isEmptyMask(mask) || !overlaps(mask, bm));
    return { code: c.code, name: c.name, options, blockedOut: all.length - options.length };
  });

  const blockedOut = prepared.filter((c) => c.blockedOut > 0)
    .map((c) => ({ name: c.name, n: c.blockedOut }));
  const impossible = prepared.filter((c) => c.options.length === 0).map((c) => c.name);
  if (impossible.length) return { combos: [], truncated: false, blockedOut, impossible, pairs: [] };

  // 2) 선택지가 적은 과목부터 깔아야 가지치기가 빨리 먹는다.
  const order = [...prepared].sort((a, b) => a.options.length - b.options.length);

  const found = [];
  let nodes = 0;
  let truncated = false;
  const stack = [];

  const rec = (i, mask) => {
    if (truncated) return;
    if (i === order.length) {
      found.push(stack.map((x) => x.s));
      if (found.length >= COMBO_LIMIT) truncated = true;
      return;
    }
    for (const opt of order[i].options) {
      if (++nodes > NODE_LIMIT) { truncated = true; return; }
      if (overlaps(mask, opt.mask)) continue;      // 이미 담긴 강의와 겹치면 그 가지는 버린다
      stack.push(opt);
      rec(i + 1, merged(mask, opt.mask));
      stack.pop();
      if (truncated) return;
    }
  };
  rec(0, new Int32Array(8));

  // 3) 점수(지표)를 매겨 둔다. 어느 순서로 보여줄지는 sortCombos 가 나중에 정한다.
  //    (화면에 뿌리기 좋게 후보 안의 강의는 과목명 순으로 세워 둔다)
  const combos = found.map((sections) => {
    const sorted = [...sections].sort((a, b) => a.course_name.localeCompare(b.course_name, 'ko'));
    return {
      sections: sorted,
      stats: comboStats(sorted, periodNos),
      sig: sorted.map((s) => s.id).join(','),
    };
  });

  return {
    combos,
    truncated,
    blockedOut,
    impossible: [],
    pairs: combos.length === 0 ? conflictPairs(prepared) : [],
  };
}
