// =====================================================================
//  기기 로컬 조회 기록 — 게시글 조회수를 '기기당 1회'만 집계(좋아요와 동일 정책).
//  서버로는 아무것도 보내지 않는다(완전 익명 유지). 시크릿모드·저장소 삭제로
//  우회 가능한 '정직한 사용자용' 잠금이며, 새로고침·반응/댓글 후 재조회로
//  조회수가 부풀지 않게 하는 게 목적.
//  ※ 이전엔 sessionStorage(세션당 1회)였다 → localStorage(기기당 1회)로 승격.
//  key 규칙: `p:<글id>`(앱 상세) | `s:<공유토큰>`(비회원 공유 열람)
// =====================================================================
const KEY = 'bb-viewed';

// 저장소를 읽을 수 있으면 기록 객체, 불가하면 null.
function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return null; }
}

// 이 기기에서 이미 조회수로 집계된 대상인가.
// 저장소 불가(null)면 '이미 봤다'로 취급 → 중복 집계 방지를 안전측으로(부풀리지 않게).
export function hasViewed(key) {
  const all = readAll();
  return !all || all[key] === true;
}

// 조회 1회 집계 기록(서버 +1 에 성공했을 때만 호출).
export function markViewed(key) {
  const all = readAll();
  if (!all) return;
  all[key] = true;
  // 무한 성장 방지: 오래된 항목(삽입순 앞쪽)부터 정리. 게시글은 90일 뒤 파기되므로 충분.
  const ids = Object.keys(all);
  if (ids.length > 1000) for (const k of ids.slice(0, ids.length - 1000)) delete all[k];
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* 저장 실패 무시 */ }
}
