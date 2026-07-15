// =====================================================================
//  기기 로컬 반응 기록 — 게시글/강의평/메모당 반응 1회 UX 제한.
//  서버로는 아무것도 보내지 않는다(완전 익명 유지). 시크릿모드·데이터 삭제로
//  우회 가능한 '정직한 사용자용 잠금'이며, 연타·중복 반응 방지가 목적.
// =====================================================================
const KEY = 'bb-reacted';

function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}

// scope: 'post'(게시글) | 'review'(강의평) | 'memo'(강의메모) | 'review-wrote'(강의평 작성 잠금)
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

// 반응 취소(좋아요/싫어요 토글 해제) — 신고는 취소 없음
export function unmarkReacted(scope, id, kind) {
  const all = readAll();
  if (all[`${scope}:${id}`]) delete all[`${scope}:${id}`][kind];
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* 저장 실패 무시 */ }
}

// ── 강의평 '이 강의에 이미 썼음' 기기 로컬 잠금 ─────────────────────────────
// 강의평은 서버가 '익명 다건'(작성자 컬럼 없음 → 익명성 유지)이라 재작성을 서버에서 못 막는다.
// 그래서 과목·교수 단위로 여기(localStorage)서 잠가 재작성 버튼을 감춘다. 위 반응 기록과
// 같은 저장소·정리 로직을 쓴다 — 시크릿모드·데이터삭제로 우회 가능한 '정직한 사용자용 잠금'.
const reviewKey = (courseCode, profCode) => `${courseCode}:${profCode || ''}`;
export const hasReviewed = (courseCode, profCode) =>
  !!getReacted('review-wrote', reviewKey(courseCode, profCode)).done;
export const markReviewed = (courseCode, profCode) =>
  markReacted('review-wrote', reviewKey(courseCode, profCode), 'done');
