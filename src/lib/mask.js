// =====================================================================
//  비속어 마스킹 진입점 (지연 로드)
//
//  왜 따로 있나: lib/moderation.js 는 korcen 사전을 끌고 와 청크가 110KB(gzip 28KB)다.
//  예전엔 게시글 화면(Post)·게시판(Board)이 이 모듈을 정적 import 해서, 글을 '읽기만' 해도
//  그 28KB 를 받고 banned_word 쿼리까지 한 번 나갔다. 마스킹은 '쓸 때' 한 번 필요할 뿐이고,
//  이미 저장된 글은 작성 시점에 마스킹돼 있다 — 읽는 사람에겐 아무 쓸모가 없었다.
//
//  그래서 실제로 글을 쓰는 순간에만 받는다:
//   - prefetchMask(): 입력창에 처음 손을 대면(onFocus) 미리 받아 둔다 → 제출은 기다림 없이 끝난다.
//   - maskText():     제출 시. 아직 안 받았으면 여기서 받고, 금지어 사전까지 기다린 뒤 마스킹한다.
// =====================================================================

let modPromise = null;

export function prefetchMask() {
  modPromise ??= import('./moderation');
  return modPromise;
}

export async function maskText(text) {
  if (!text) return text;
  const mod = await prefetchMask();
  await mod.bannedWordsReady;   // 관리자 금지어가 반영된 뒤에 마스킹
  return mod.maskProfanity(text);
}
