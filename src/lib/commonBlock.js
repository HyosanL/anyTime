// =====================================================================
//  전 생도 공통 비수업 시간(생도대·군사훈련·공통연구 …)을 시간표 격자에 깔기
//
//  DB(customClasses)에 담지 않는다 — 모두에게 똑같은 시간이라 계정마다 저장할 이유가 없다.
//  담으면 ① 생도 수만큼 쓰기가 생기고 ② 학기가 바뀔 때마다 옛 항목이 남으며
//  ③ 마법사의 '빈 시간표 재사용' 판정이 깨진다(강의는 없는데 항목이 있으니 안 비어 보인다).
//  대신 카탈로그(commonBlocks)에서 그때그때 계산해 격자에만 깐다.
//
//  다만 지울 수는 있어야 한다 — 탭하면 그 블록을 숨긴다. 숨김은 기기(localStorage)에만
//  남는다(서버 쓰기 0). 학기별로 따로 기억하고, 언제든 되돌릴 수 있다.
// =====================================================================

const hideKey = (sem) => `anytime:hiddenBlocks:${sem.year}-${sem.term}`;

// 블록의 신원 — 요일 + 시각 구간. (이름이 바뀌어도 같은 블록으로 본다)
export const blockKey = (b) => `${b.day}-${b.startMin}-${b.endMin}`;

export function readHidden(sem) {
  if (!sem) return new Set();
  try {
    const raw = localStorage.getItem(hideKey(sem));
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function writeHidden(sem, set) {
  try { localStorage.setItem(hideKey(sem), JSON.stringify([...set])); } catch { /* 있으면 좋고 없어도 그만 */ }
}

export function hideBlock(sem, block) {
  const set = readHidden(sem);
  set.add(blockKey(block));
  writeHidden(sem, set);
  return set;
}

export function unhideAll(sem) {
  try { localStorage.removeItem(hideKey(sem)); } catch { /* ignore */ }
  return new Set();
}

// commonBlocks(교시 단위) → 격자가 쓰는 분(minute) 구간. 교시 시각(period)이 없으면 못 그린다.
// hidden 에 든 블록은 빼고 돌려준다.
export function buildCommonBlocks(catalog, sem, hidden = new Set()) {
  if (!sem) return [];
  const periodByNo = Object.fromEntries((catalog?.periods ?? []).map((p) => [p.no, p]));
  const toMin = (t) => {
    if (!t) return null;
    const [h, m] = String(t).split(':').map(Number);
    return Number.isFinite(h) ? h * 60 + (m || 0) : null;
  };
  return (catalog?.commonBlocks ?? [])
    .filter((b) => b.year === sem.year && b.term === sem.term)
    .map((b) => {
      const startMin = toMin(periodByNo[b.startPeriod]?.startTime);
      const endMin = toMin(periodByNo[b.endPeriod]?.endTime);
      if (startMin == null || endMin == null || endMin <= startMin) return null;
      return { day: b.dayOfWeek, startMin, endMin, label: b.label };
    })
    .filter(Boolean)
    .filter((b) => !hidden.has(blockKey(b)))
    .sort((a, b) => a.day - b.day || a.startMin - b.startMin);
}
