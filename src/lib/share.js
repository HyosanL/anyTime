// 링크 공유 공통 헬퍼.
// - 지원 기기(모바일 대부분): navigator.share 로 OS 공유 시트(카톡·메시지 등)를 연다.
// - 미지원(데스크톱 등): 클립보드에 복사, 그마저 막히면 prompt 로 노출.
// 반환값: 'shared' | 'cancelled' | 'copied' | 'prompt'
export async function shareLink({ title, text, url }) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text: text || title, url });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled'; // 사용자가 공유 취소
      // 그 외 실패는 아래 복사로 폴백
    }
  }
  // 폴백은 문구+링크를 함께 복사 — 붙여넣기만 해도 무슨 링크인지 맥락이 남게.
  const payload = text ? `${text}\n${url}` : url;
  try {
    await navigator.clipboard.writeText(payload);
    alert('링크를 복사했어요. 붙여넣어 공유하세요.');
    return 'copied';
  } catch {
    prompt('아래 내용을 복사해 공유하세요', payload);
    return 'prompt';
  }
}

// 앱 절대경로(path)로 공유 URL 생성. (예: `/s/<token>`)
export const appUrl = (path) => `${window.location.origin}${path}`;
