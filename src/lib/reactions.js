// =====================================================================
//  기기 로컬 반응 기록 — 게시글/강의평/메모당 반응 1회 UX 제한.
//  서버로는 아무것도 보내지 않는다(완전 익명 유지). 시크릿모드·데이터 삭제로
//  우회 가능한 '정직한 사용자용 잠금'이며, 연타·중복 반응 방지가 목적.
// =====================================================================
const KEY = 'bb-reacted';

function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}

// scope: 'post'(게시글) | 'review'(강의평) | 'memo'(강의메모)
export function getReacted(scope, id) {
  return readAll()[`${scope}:${id}`] || {};
}

export function markReacted(scope, id, kind) {
  const all = readAll();
  (all[`${scope}:${id}`] ??= {})[kind] = true;
  // 무한 성장 방지: 오래된 항목(삽입순 앞쪽)부터 정리. 게시글은 90일 뒤 파기되므로 충분.
  const ids = Object.keys(all);
  if (ids.length > 500) for (const k of ids.slice(0, ids.length - 500)) delete all[k];
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* 저장 실패 무시 */ }
}
