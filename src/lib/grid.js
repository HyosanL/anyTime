// =====================================================================
//  편람 주간 시간표 격자 파서 (좌표 기반 · AI 호출 0회 · 비용 0원)
//
//  왜 필요한가 — 편람의 '세부내용 표'는 틀린다. 2026-2 편람만 해도 4건이 틀렸다
//  (신호및시스템 1분반: 표는 '월12 목1', 격자는 '화1 화2 목1'). AI 는 표를 충실히
//  옮겼을 뿐이고, 모델을 올려도 프롬프트를 고쳐도 이건 못 잡는다 — 원문이 틀렸으니까.
//  같은 편람의 '주간 격자'가 정답지다. 그리고 격자는 AI 없이 좌표로 읽힌다.
//
//  격자에서 두 가지를 얻는다:
//    ① 전 생도 공통 비수업 시간(생도대·군사훈련·공통연구 …) — common_block 의 근거
//    ② 과목별 요일·교시 — 세부내용 표와 대조해 오류를 잡는다
//
//  ⚠ 편람 양식은 해마다 바뀐다. 실제로 26-1 '학위교육 운영계획'은 요일 아래에
//    학과별 하위 열이 또 있고 과목명이 세로쓰기라 이 파서로는 못 읽는다.
//    그래서 좌표를 하나도 하드코딩하지 않고(헤더·교시열을 구조로 찾고, 허용오차는
//    탐지한 간격에서 유도한다), 읽은 결과가 말이 되는지 검사해서(looksSane)
//    아니면 조용히 포기한다. 못 읽으면 교차검증을 건너뛸 뿐 기존 동작은 그대로다.
// =====================================================================

const DAYS = ['월', '화', '수', '목', '금'];

// 격자 칸에 나오지만 강의가 아닌 것 = 전 생도 비수업 시간의 이름
const COMMON_LABELS = ['생도대', '군사훈련', '자기주도적역량', '공통연구', '전생도연구시간', '학과준비'];

// 격자 칸에 나오지만 과목명이 아닌 것(무엇을 듣는지는 세부내용 표가 정한다)
const PLACEHOLDERS = ['교양선택', '일반학', '체육', '군사학', '전공', '선택'];

export function commonLabelOf(text) {
  return COMMON_LABELS.find((c) => text.includes(c)) ?? null;
}
export const isPlaceholder = (text) => PLACEHOLDERS.some((p) => text.includes(p));

// pdf.js TextContent → { x, y, s }
export function toItems(textContent) {
  return (textContent.items ?? [])
    .filter((t) => t.str && t.str.trim())
    .map((t) => ({ x: Math.round(t.transform[4]), y: Math.round(t.transform[5]), s: t.str.trim() }));
}

// 읽은 격자가 '말이 되는가'. 세로쓰기 표(26-1 양식)를 억지로 읽으면 칸마다 한 글자씩
// 떨어지므로 여기서 걸린다 — 쓰레기를 자신 있게 내놓는 것이 최악이다.
function looksSane(cells) {
  const vals = Object.values(cells);
  if (vals.length < 10) return false;
  const words = vals.filter((v) => v.length >= 2).length;
  return words / vals.length >= 0.7;
}

/**
 * 한 페이지에서 격자를 '전부' 읽는다.
 * 한 쪽에 격자가 둘씩 쌓여 있다(2학년 컴퓨터 격자 아래 전자 격자). 위쪽 하나만 읽으면
 * 아래 격자의 과목(신호및시스템 등)을 통째로 놓친다.
 * @returns [{ cells: { "요일-교시": 텍스트 }, periods: number[] }]  — 못 읽으면 빈 배열
 */
export function parseGridsOnPage(items) {
  // 1) '월 화 수 목 금'이 같은 y 에 나란한 줄 = 격자 헤더. 페이지에 여러 개 있을 수 있다.
  const byY = {};
  for (const i of items) if (DAYS.includes(i.s)) (byY[i.y] ??= []).push(i);
  const headerYs = Object.keys(byY).map(Number)
    .filter((y) => new Set(byY[y].map((i) => i.s)).size >= 5)
    .sort((a, b) => b - a);
  if (!headerYs.length) return [];

  const out = [];
  headerYs.forEach((headerY, hi) => {
    // 이 격자의 세로 범위: 이 헤더 아래 ~ 다음 헤더 위
    const floorY = hi + 1 < headerYs.length ? headerYs[hi + 1] : -Infinity;
    const cols = byY[headerY].sort((a, b) => a.x - b.x);
    if (cols.length < 5) return;

    // 2) 그 범위 안, 헤더 왼쪽 아래의 1~9 = 교시 행.
    const left = cols[0].x;
    const periodItems = items
      .filter((i) => i.y < headerY && i.y > floorY && i.x < left - 20 && /^[1-9]$/.test(i.s))
      .sort((a, b) => b.y - a.y);
    const periods = [];
    for (const i of periodItems) {                       // 같은 교시가 두 번 찍히면 첫 것만
      if (!periods.some((p) => p.no === Number(i.s))) periods.push({ no: Number(i.s), y: i.y });
    }
    if (periods.length < 4) return;

    // 3) 허용오차는 '탐지한 간격'에서 유도한다 — 폰트·여백이 바뀌어도 따라간다.
    const colGap = Math.abs(cols[1].x - cols[0].x) || 80;
    const rowGap = periods.length > 1 ? Math.abs(periods[0].y - periods[1].y) || 24 : 24;
    const xTol = colGap * 0.55;
    const yTol = rowGap * 0.55;

    // 4) 각 조각을 (가장 가까운 요일 열, 가장 가까운 교시 행)에 배정.
    const bucket = {};
    const minY = periods[periods.length - 1].y - rowGap;
    for (const it of items) {
      if (it.y >= headerY || it.y < minY || it.x < left - xTol) continue;
      const col = cols.reduce((b, c) => (Math.abs(c.x - it.x) < Math.abs(b.x - it.x) ? c : b));
      if (Math.abs(col.x - it.x) > xTol) continue;
      const row = periods.reduce((b, p) => (Math.abs(p.y - it.y) < Math.abs(b.y - it.y) ? p : b));
      if (Math.abs(row.y - it.y) > yTol) continue;
      (bucket[`${DAYS.indexOf(col.s) + 1}-${row.no}`] ??= []).push(it);
    }

    const cells = {};
    for (const [k, list] of Object.entries(bucket)) {
      // 같은 낱말이 여러 조각으로 들어오는 일이 잦다 → 중복 조각은 한 번만 이어 붙인다.
      const s = [...new Set(list.sort((a, b) => a.x - b.x).map((i) => i.s))].join('').replace(/\s+/g, '');
      if (s) cells[k] = s;
    }
    if (!looksSane(cells)) return;
    out.push({ cells, periods: periods.map((p) => p.no).sort((a, b) => a - b) });
  });
  return out;
}

/**
 * 전 생도 공통 비수업 시간 — 모든 격자가 똑같이 비수업으로 표시한 칸만 채택한다.
 * (월7·8 '자기주도적역량'은 1학년만 체육이라 전 학년 공통이 아니다 → 채택하지 않는다)
 * @param grids parseGridPage 결과 배열
 * @returns [{ day, start, end, label }] — 이어진 교시는 한 블록으로
 */
export function universalBlocks(grids) {
  if (grids.length < 2) return [];          // 격자 한 장으로는 '전 학년 공통'을 말할 수 없다
  const hits = {};                          // "요일-교시" → { pages:Set, label }
  for (let gi = 0; gi < grids.length; gi++) {
    for (const [k, v] of Object.entries(grids[gi].cells)) {
      const label = commonLabelOf(v);
      if (!label) continue;
      (hits[k] ??= { pages: new Set(), label }).pages.add(gi);
    }
  }
  const all = Object.entries(hits)
    .filter(([, h]) => h.pages.size === grids.length)   // 한 격자라도 강의가 있으면 공통이 아니다
    .map(([k, h]) => {
      const [day, period] = k.split('-').map(Number);
      return { day, period, label: h.label };
    })
    .sort((a, b) => a.day - b.day || a.period - b.period);

  // 이어진 교시 + 같은 이름 → 한 블록
  const out = [];
  let run = null;
  for (const c of all) {
    if (run && run.day === c.day && run.end + 1 === c.period && run.label === c.label) {
      run.end = c.period;
      continue;
    }
    run = { day: c.day, start: c.period, end: c.period, label: c.label };
    out.push(run);
  }
  return out;
}

// 격자 칸의 과목 표기 → 대조용 키. "우주공학개론3" 처럼 분반번호가 붙어 오고,
// "데이터분석"처럼 줄여 쓰기도 한다 → 이름은 접두사 일치로 느슨하게 본다.
export function cellCourse(text) {
  const m = text.match(/^(.+?)(\d+)?$/);
  return { name: (m?.[1] ?? text).replace(/[_\s]/g, ''), sectionNo: m?.[2] ? Number(m[2]) : null };
}

/**
 * 격자가 말하는 '그 과목이 열리는 요일·교시'. 세부내용 표 대조용.
 * @returns Map<과목명(격자 표기), Set<"요일-교시">>
 */
export function courseSlots(grids) {
  const map = new Map();
  for (const g of grids) {
    for (const [k, v] of Object.entries(g.cells)) {
      if (commonLabelOf(v) || isPlaceholder(v)) continue;
      const { name } = cellCourse(v);
      if (name.length < 2) continue;
      (map.get(name) ?? map.set(name, new Set()).get(name)).add(k);
    }
  }
  return map;
}

// 격자 표기와 세부내용 표의 과목명은 서로 줄여 쓴다("데이터분석" ↔ "데이터분석방법론").
// 한쪽이 다른 쪽의 앞부분이면 같은 과목으로 본다.
const sameCourse = (a, b) => a.startsWith(b) || b.startsWith(a);

/**
 * 세부내용 표에서 뽑은 분반을 격자와 대조한다.
 *
 * 격자에 없는 요일·교시를 표가 주장하면 표가 틀린 것이다 — 2026-2 편람의
 * 신호및시스템 1분반이 그랬다(표 '월1 월2 목1' / 격자 '화1 화2 목1').
 * 그 과목이 어느 격자에도 없으면 판단하지 않는다(모르는 것은 모른다고 둔다).
 *
 * @param rows   [{ course, sectionNo, times:[{day,period}] }]  — AI/CSV 파싱 결과
 * @param grids  parseGridsOnPage 결과들
 * @returns { checked, mismatches:[{course,sectionNo,table:[],grid:[],missing:[]}], coverage }
 *   coverage = 격자 과목명 중 표에도 있는 비율. 낮으면 격자를 잘못 읽은 것이다(양식 변경).
 */
export function crossCheck(rows, grids) {
  const slots = courseSlots(grids);
  const names = [...new Set(rows.map((r) => r.course))];

  // 격자를 제대로 읽었는지부터 본다 — 격자 과목명이 표의 과목명과 거의 안 겹치면
  // 다른 양식을 억지로 읽은 것이다(26-1 '학위교육 운영계획'이 그렇다). 그러면 대조하지 않는다.
  const known = [...slots.keys()].filter((g) => names.some((n) => sameCourse(n, g)));
  const coverage = slots.size ? known.length / slots.size : 0;
  if (coverage < 0.5) return { checked: 0, mismatches: [], coverage };

  // 격자 표기 → 어느 과목인가. 여러 과목이 걸리면(기계학습 ↔ 기계학습(컴퓨터)) 정확히
  // 같은 이름이 있으면 그것으로, 없으면 모호하니 그 격자 표기는 아예 쓰지 않는다.
  const bind = new Map();      // 격자 표기 → 과목명
  for (const g of slots.keys()) {
    const cands = names.filter((n) => sameCourse(n, g));
    if (cands.length === 1) bind.set(g, cands[0]);
    else if (cands.includes(g)) bind.set(g, g);
  }

  // 과목별로 격자 칸을 모은다(그 과목의 모든 분반이 흩어져 있는 합집합).
  const gridOf = new Map();
  for (const [g, set] of slots) {
    const name = bind.get(g);
    if (!name) continue;
    const mine = gridOf.get(name) ?? gridOf.set(name, new Set()).get(name);
    for (const k of set) mine.add(k);
  }

  // 표가 말하는 그 과목의 전체 칸(모든 분반 합집합).
  const tableOf = new Map();
  for (const r of rows) {
    if (!r.times?.length) continue;
    const set = tableOf.get(r.course) ?? tableOf.set(r.course, new Set()).get(r.course);
    for (const t of r.times) set.add(`${t.day}-${t.period}`);
  }

  const mismatches = [];
  let checked = 0;
  for (const r of rows) {
    if (!r.times?.length) continue;
    const mine = gridOf.get(r.course);
    if (!mine) continue;                       // 격자에 없는 과목 → 판단 보류

    // ★ 격자가 그 과목을 '빠짐없이' 적었을 때만 대조한다.
    //   1학년 격자는 과목명 대신 '일반학'·'교양선택' 같은 자리표시자를 쓴다. 그러면 그 과목의
    //   격자 칸이 실제보다 적어, 표가 맞는데도 "격자에 없는 요일"이 되어 몽땅 오탐이 된다.
    //   칸 수가 표와 같을 때만 = 격자가 그 과목을 다 적었을 때만 믿는다.
    if (mine.size !== (tableOf.get(r.course)?.size ?? 0)) continue;

    // ★ 교시가 아니라 '요일'로 대조한다.
    //   격자는 과목명을 줄여 쓰고(데이터분석 ↔ 데이터분석방법론), 1학년 격자는 아예
    //   '일반학'·'교양선택' 같은 자리표시자를 쓴다. 그래서 교시 단위로 맞추면 표가 맞는데도
    //   "격자에 없는 시간"이 되어 오탐이 쏟아진다(실측 12건).
    //   반면 요일은 격자가 어느 그룹에서든 반드시 그 자리에 찍는다 — 그리고 실제 원문 오류도
    //   대부분 요일 오독이다(신호및시스템 화→월, 열역학 수→목). 요일만 보면 정밀도가 산다.
    const gridDays = new Set([...mine].map((k) => Number(k.split('-')[0])));
    checked += 1;
    const badDays = [...new Set(r.times.map((t) => t.day))].filter((d) => !gridDays.has(d));
    if (badDays.length) {
      mismatches.push({
        course: r.course, sectionNo: r.sectionNo,
        table: r.times.map((t) => `${t.day}-${t.period}`),
        grid: [...mine].sort(),
        badDays,
      });
    }
  }
  return { checked, mismatches, coverage };
}
