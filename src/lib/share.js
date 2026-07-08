// 링크 공유 공통 헬퍼.
// - 지원 기기(모바일 대부분): navigator.share 로 OS 공유 시트(카톡·메시지 등)를 연다.
// - 미지원(데스크톱 등): 클립보드에 복사, 그마저 막히면 prompt 로 노출.
// 반환값: 'shared' | 'cancelled' | 'copied' | 'prompt'
export async function shareLink({ title, text, url }) {
  // text/url 을 따로 넘기면 수신 앱(카톡 등)이 둘 사이에 빈 줄을 끼워 넣는다(iOS 공유시트의
  // 항목 병합 방식). 문구+링크를 한 텍스트로 합쳐 줄바꿈을 직접 통제한다 — 링크 미리보기
  // 카드는 텍스트 안의 URL 로도 정상 생성된다.
  const payload = text ? `${text}\n${url}` : url;
  if (navigator.share) {
    try {
      await navigator.share({ title, text: payload });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled'; // 사용자가 공유 취소
      // 그 외 실패는 아래 복사로 폴백
    }
  }
  // 폴백은 같은 내용(문구+링크)을 복사 — 붙여넣기만 해도 무슨 링크인지 맥락이 남게.
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
