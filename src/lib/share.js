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
  try {
    await navigator.clipboard.writeText(url);
    alert('링크를 복사했어요. 붙여넣어 공유하세요.');
    return 'copied';
  } catch {
    prompt('아래 링크를 복사해 공유하세요', url);
    return 'prompt';
  }
}

// 앱 절대경로(path)로 공유 URL 생성. (예: `/board/post/12`)
export const appUrl = (path) => `${window.location.origin}${path}`;
