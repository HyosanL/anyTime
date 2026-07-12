import { useRegisterSW } from 'virtual:pwa-register/react';

// 새 배포 감지 주기. 설치형 PWA(standalone)는 전체 새로고침이 드물어 브라우저 기본
// 감지가 늦다(길게는 24h) → 앱이 켜져 있는 동안 주기적으로, 그리고 포그라운드로
// 돌아올 때마다 registration.update() 로 새 SW 유무를 직접 당겨온다.
const CHECK_INTERVAL_MS = 60 * 1000; // 1분

// PWA 업데이트 알림 배너.
// - registerType:'prompt' → 새 SW 는 '대기' 상태로 설치되고 needRefresh 가 true 가 된다.
// - "새로고침"을 누르면 updateServiceWorker() 가 대기 SW 를 활성화(skipWaiting)하고 리로드.
// - 누르지 않아도 대기 SW 는 앱을 완전히 닫았다 열면 자동 활성화된다(자동 업데이트 유지).
export default function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, r) {
      if (!r) return;
      const check = () => {
        if (navigator.onLine) r.update(); // 오프라인이면 스킵(에러 로그 방지)
      };
      setInterval(check, CHECK_INTERVAL_MS);
      // 백그라운드에 있던 앱이 다시 앞으로 나올 때 즉시 확인 → 반영 지연 최소화
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    },
  });

  if (!needRefresh) return null;

  return (
    <div className="update-toast" role="status" aria-live="polite">
      <span className="update-msg">✨ 새 버전이 나왔어요</span>
      <span className="update-actions">
        <button className="update-yes" onClick={() => updateServiceWorker(true)}>
          새로고침
        </button>
        <button className="update-no" onClick={() => setNeedRefresh(false)} aria-label="닫기">
          ✕
        </button>
      </span>
    </div>
  );
}
