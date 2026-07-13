// 시간표 마법사 임시저장 — 마법사를 벗어나도(뒤로가기·앱 종료·새로고침) 담아 둔 것이 남는다.
//
// 서버에 두지 않는다. 마법사의 입력은 전부 브라우저 안에서만 쓰이는 계산 재료라 기기 밖으로
// 나갈 이유가 없고, 과목을 담고 분반을 켤 때마다 서버에 쓰면 손가락질 수만큼 요청이 늘어난다.
// 저장은 마법사가 끝날 때 한 번(timetable · timetable_entry)이면 충분하다.
//
// 담는 것은 '입력'뿐이다 — 후보 선택(chosen·names)은 담지 않는다. 입력이 하나라도 바뀌면
// 조합이 달라져 이전 선택은 어차피 무효라, 마법사 스스로도 resetResults() 로 지우는 값이다.
const KEY = 'anytime:wizardDraft';
const VERSION = 1;
const TTL = 14 * 24 * 60 * 60 * 1000;   // 2주 — 그보다 오래된 초안은 카탈로그가 통째로 바뀌었을 수 있다

export function readDraft(uid) {
  if (!uid) return null;
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!d || d.v !== VERSION || d.uid !== uid || !d.semKey) return null;   // 남의 계정 초안은 남의 것
    if (Date.now() - (d.at ?? 0) > TTL) return null;

    // 손상된 값 하나로 마법사가 열리지 않는 일은 없어야 한다 — 모양이 어긋나면 통째로 버린다.
    const picked = (Array.isArray(d.picked) ? d.picked : [])
      .filter((p) => p && typeof p.code === 'string')
      .map((p) => ({
        code: p.code,
        offKeys: Array.isArray(p.offKeys) ? p.offKeys.filter((k) => typeof k === 'string') : [],
        offSecs: Array.isArray(p.offSecs) ? p.offSecs.filter(Number.isInteger) : [],
      }));
    if (picked.length === 0) return null;      // 담은 과목이 없으면 되살릴 것도 없다

    return {
      step: [1, 2, 3, 4].includes(d.step) ? d.step : 1,
      semKey: String(d.semKey),
      picked,
      blocked: new Set(Array.isArray(d.blocked) ? d.blocked.filter((k) => typeof k === 'string') : []),
      sortMode: typeof d.sortMode === 'string' ? d.sortMode : 'free',
      profPick: (d.profPick && typeof d.profPick === 'object' && !Array.isArray(d.profPick)) ? d.profPick : {},
    };
  } catch {
    return null;
  }
}

// 과목을 하나도 담지 않은 상태는 초안이 아니다 — 지운다. 그래야 '새로 시작'과 학기 변경이
// 따로 뒤처리할 것 없이 저절로 깨끗해진다.
export function writeDraft(uid, { step, semKey, picked, blocked, sortMode, profPick }) {
  if (!uid || !semKey || !picked?.length) { clearDraft(); return; }
  try {
    localStorage.setItem(KEY, JSON.stringify({
      v: VERSION,
      uid,
      at: Date.now(),
      step,
      semKey,
      picked,
      blocked: [...blocked],      // Set 은 JSON 으로 그냥 나가지 않는다
      sortMode,
      profPick,
    }));
  } catch {
    // 용량 초과·시크릿 모드. 임시저장은 있으면 좋은 것이지, 없다고 마법사를 못 쓰면 안 된다.
  }
}

export function clearDraft() {
  try { localStorage.removeItem(KEY); } catch { /* 위와 같다 */ }
}
