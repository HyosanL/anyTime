// =====================================================================
//  시간표 마법사 — 조합 생성기 (순수 계산. 서버 접근 없음)
//
//  들어야 하는 과목을 담고 과목마다 '가능한 분반'만 켜 두면,
//  그 분반들로 만들 수 있는 겹치지 않는 시간표를 모두 찾아 점수를 매겨 돌려준다.
//
//  ★ 핵심 규칙 — 후보에 등장하는 분반은 사용자가 켠 분반뿐이다.
//    (항공기상에서 1분반만 켰다면 2·3분반은 어떤 후보에도 들어가지 않는다.
//     생성기는 allowed 밖의 분반을 애초에 입력으로 받지 않는다.)
//
//  ★ 같은 시간 = 같은 후보 — 같은 과목·같은 시간에 교수만 다른 분반(체력단련 4개,
//    무도 3개, 영어회화 3개…)은 시간표 격자에서 완전히 똑같은 그림이다. 이걸 따로
//    세면 후보가 교수 수의 곱(4×3×3=36배)만큼 뻥튀기된다. 그래서 조합은 '시간 묶음'
//    단위로 만들고, 교수는 후보를 고른 뒤에 따로 선택한다.
//
//  ★ 비수업 시간 — 그 학기에 어떤 분반도 열리지 않는 요일×교시(생도대시간·군사훈련·
//    자율선택형교과)는 '빈 시간'이 아니다. 원래 수업이 없는 시간이다. 카탈로그에서
//    그대로 유도해 빈 시간 계산에서 뺀다(이걸 안 빼면 화3·4 같은 칸이 공강으로 잡힌다).
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

// 요일×교시 격자(Set of "요일-교시") → 마스크
export function slotMask(slots) {
  const m = new Int32Array(8);
  for (const key of slots ?? []) {
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

// ---------------------------------------------------------------------
//  전 생도 공통 비수업 시간 (생도대시간 · 군사훈련 · 자율선택형교과 …)
//
//  그 학기에 '어떤 분반도 열리지 않는' 요일×교시가 곧 그 시간이다.
//  편람에 구멍으로 찍혀 있으므로 카탈로그만 있으면 그대로 읽어낼 수 있다 —
//  따로 등록하지 않아도 학기가 바뀌면 자동으로 따라온다.
//  (이름[생도대시간·군사훈련…]만 관리자가 붙인다 — common_block)
// ---------------------------------------------------------------------
export function deriveNoClass(sections, periodNos) {
  const out = new Set();
  if (!sections?.length || !periodNos?.length) return out;   // 카탈로그가 비면 유도하지 않는다
  const used = new Set();
  for (const s of sections) {
    for (const t of s.times ?? []) {
      for (let p = t.start_period; p <= t.end_period; p++) used.add(`${t.day_of_week}-${p}`);
    }
  }
  for (let d = 1; d <= 5; d++) {          // 평일만 — 주말은 원래 수업이 없다
    for (const p of periodNos) {
      if (!used.has(`${d}-${p}`)) out.add(`${d}-${p}`);
    }
  }
  return out;
}

// 이어진 비수업 칸을 하나의 블록으로 접는다 — 화면·이름표(관리자)의 단위.
// [{ day, start, end }]  (같은 요일에서 교시가 연속인 것끼리)
export function noClassBlocks(noClass, periodNos) {
  const out = [];
  for (let d = 1; d <= 5; d++) {
    let run = null;
    periodNos.forEach((p, i) => {
      if (!noClass.has(`${d}-${p}`)) { run = null; return; }
      if (run && run.lastIdx === i - 1) { run.end = p; run.lastIdx = i; return; }
      run = { day: d, start: p, end: p, lastIdx: i };
      out.push(run);
    });
  }
  return out.map(({ day, start, end }) => ({ day, start, end }));
}

// ---------------------------------------------------------------------
//  같은 시간 분반 묶기 — 교수만 다른 분반은 한 덩어리로 본다.
// ---------------------------------------------------------------------
export function timeKey(times) {
  const ts = [...(times ?? [])]
    .map((t) => `${t.day_of_week}:${t.start_period}-${t.end_period}`)
    .sort();
  return ts.length ? ts.join('|') : 'none';   // 'none' = 강의시간 미정
}

// sections → [{ key, times, sections:[분반…] }]  (이른 시간 순)
export function groupByTime(sections) {
  const m = new Map();
  for (const s of sections ?? []) {
    const k = timeKey(s.times);
    if (!m.has(k)) m.set(k, { key: k, times: s.times ?? [], sections: [] });
    m.get(k).sections.push(s);
  }
  const first = (g) => {
    const t = [...g.times].sort((a, b) => a.day_of_week - b.day_of_week || a.start_period - b.start_period)[0];
    return t ? t.day_of_week * 100 + t.start_period : 9999;
  };
  return [...m.values()].sort((a, b) => first(a) - first(b));
}

// ---------------------------------------------------------------------
//  후보의 성격 — 공강일 / 반일 공강 / 1교시 / 낀 시간
//
//  주의: '비는 교시의 총합'은 지표가 되지 못한다 — 같은 과목들을 듣는 한 한 주의 수업
//  교시 수는 어느 후보든 똑같아서, 비는 교시 총합도 항상 같기 때문이다. 의미 있는 건
//  그 빈 시간이 '어떻게 뭉치느냐'다:
//    · 공강일   — 하루가 통째로 빈다 (가장 크다)
//    · 반일 공강 — 오전(1~4교시) 또는 오후(5~8교시)가 통째로 빈다
//    · 낀 시간   — 수업과 수업 사이에 끼어 뜨는 교시(하루의 맨 앞·맨 뒤가 비는 건 위에서 셌다)
//  noClass(생도대·군사훈련·자율선택형교과)는 원래 수업이 없는 시간이라 어느 쪽으로도 세지 않는다.
// ---------------------------------------------------------------------
const AM_LAST = 4;   // 1~4교시 = 오전, 5교시부터 오후

export function comboStats(groups, periodNos, noClass = new Set()) {
  const m = new Int32Array(8);
  for (const g of groups) {
    const gm = timeMask(g.times);
    for (let d = 1; d <= 7; d++) m[d] |= gm[d];
  }
  const firstPeriod = periodNos[0] ?? 1;
  const freeDays = [];
  const amFree = [];
  const pmFree = [];
  let early = 0;
  let gaps = 0;
  let dayCount = 0;

  for (let d = 1; d <= 7; d++) {
    if (!m[d]) {
      if (d >= 1 && d <= 5) freeDays.push(d);   // 공강일은 평일만 센다
      continue;
    }
    dayCount++;
    if (m[d] & (1 << firstPeriod)) early++;

    // 반일 공강 — 그날 수업은 있지만 오전(또는 오후)이 통째로 빈다.
    // 비수업 교시는 후보를 가리는 데 쓸 수 없으니 뺀다: 금5~8 은 전 생도가 수업이 없어서
    // '오후공강 금'이 어느 후보에나 붙는다 — 아무것도 구분하지 못하는 지표가 된다.
    const amSlots = periodNos.filter((p) => p <= AM_LAST && !noClass.has(`${d}-${p}`));
    const pmSlots = periodNos.filter((p) => p > AM_LAST && !noClass.has(`${d}-${p}`));
    if (amSlots.length && !amSlots.some((p) => m[d] & (1 << p))) amFree.push(d);
    if (pmSlots.length && !pmSlots.some((p) => m[d] & (1 << p))) pmFree.push(d);

    // 낀 시간 — 첫 수업과 마지막 수업 사이의 빈 교시(비수업 시간 제외).
    const used = periodNos.filter((p) => m[d] & (1 << p));
    const first = used[0];
    const last = used[used.length - 1];
    gaps += periodNos.filter(
      (p) => p > first && p < last && !(m[d] & (1 << p)) && !noClass.has(`${d}-${p}`)
    ).length;
  }
  const unscheduled = groups.filter((g) => !(g.times?.length)).length;
  return { freeDays, amFree, pmFree, early, gaps, dayCount, unscheduled };
}

const halfDays = (s) => s.amFree.length + s.pmFree.length;

// 정렬: 무엇을 먼저 볼 것인가. (동점이면 나머지 지표로 차례차례 가른다)
export const SORTS = {
  free:  { label: '공강일 많은 순',      key: (x) => [-x.stats.freeDays.length, -halfDays(x.stats), x.stats.gaps, x.stats.early] },
  half:  { label: '반일 공강 많은 순',   key: (x) => [-halfDays(x.stats), -x.stats.freeDays.length, x.stats.gaps, x.stats.early] },
  early: { label: '1교시 적은 순',       key: (x) => [x.stats.early, -x.stats.freeDays.length, -halfDays(x.stats), x.stats.gaps] },
  gap:   { label: '낀 시간 적은 순',     key: (x) => [x.stats.gaps, -x.stats.freeDays.length, -halfDays(x.stats), x.stats.early] },
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

// 두 과목이 '고른 분반으로는 절대 함께 못 듣는' 사이인지 — 조합이 0일 때 이유를 알려주려고.
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
 * @param courses   [{ code, name, options: Group[] }]   options = 사용자가 켠 '시간 묶음'만
 *                  Group = { key, times, sections:[분반…] }  (groupByTime 의 결과)
 * @param blocked   Set<"요일-교시">  피하고 싶은 시간(그 시간을 쓰는 묶음은 후보에서 제외)
 * @param periodNos 교시 번호 오름차순
 * @param noClass   Set<"요일-교시">  전 생도 비수업 시간(빈 시간으로 세지 않는다)
 * @returns { combos, truncated, blockedOut, impossible, pairs }
 *   combos     : [{ groups, stats, sig }]  정렬 전(순서는 sortCombos 가 정한다)
 *   blockedOut : 기피 시간 때문에 빠진 시간 묶음 수(과목별)
 *   impossible : 기피 시간 때문에 남은 묶음이 0개가 된 과목명
 */
export function generateCombos({ courses, blocked, periodNos, noClass = new Set() }) {
  const bm = slotMask(blocked);

  // 1) 기피 시간과 겹치는 묶음을 먼저 걷어낸다.
  const prepared = courses.map((c) => {
    const all = (c.options ?? []).map((g) => ({ g, mask: timeMask(g.times) }));
    const keep = (x) => isEmptyMask(x.mask) || !overlaps(x.mask, bm);
    const options = all.filter(keep);
    // 사람이 세는 단위는 '분반'이다 — 빠진 시간 묶음이 아니라 빠진 분반 수를 알려준다.
    const dropped = all.filter((x) => !keep(x)).reduce((n, x) => n + x.g.sections.length, 0);
    return { code: c.code, name: c.name, options, blockedOut: dropped };
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
      found.push(stack.map((x) => x.g));
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

  // 3) 지표를 매겨 둔다. 어느 순서로 보여줄지는 sortCombos 가 나중에 정한다.
  const combos = found.map((groups) => {
    const sorted = [...groups].sort((a, b) =>
      a.sections[0].course_name.localeCompare(b.sections[0].course_name, 'ko')
    );
    return {
      groups: sorted,
      stats: comboStats(sorted, periodNos, noClass),
      sig: sorted.map((g) => `${g.sections[0].course_code}@${g.key}`).join(','),
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
