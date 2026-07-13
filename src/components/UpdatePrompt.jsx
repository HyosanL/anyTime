import { useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

// 새 배포 감지 주기. 설치형 PWA(standalone)는 전체 새로고침이 드물어 브라우저 기본
// 감지가 늦다(길게는 24h) → 앱이 켜져 있는 동안 주기적으로, 그리고 포그라운드로
// 돌아올 때마다 registration.update() 로 새 SW 유무를 직접 당겨온다.
const CHECK_INTERVAL_MS = 60 * 1000; // 1분

// skipWaiting 이후 컨트롤러 교체(controllerchange)를 기다리는 한계. 아래 refresh() 참고.
const CONTROLLER_WAIT_MS = 1500;

// PWA 업데이트 알림 배너.
// - registerType:'prompt' → 새 SW 는 '대기' 상태로 설치되고 needRefresh 가 true 가 된다.
// - "새로고침"을 누르면 대기 SW 를 활성화(skipWaiting)하고 페이지를 리로드한다.
// - 누르지 않아도 대기 SW 는 앱을 완전히 닫았다 열면 자동 활성화된다(자동 업데이트 유지).
export default function UpdatePrompt() {
  const [busy, setBusy] = useState(false);
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

  // 리로드는 우리가 직접 한다. vite-plugin-pwa 의 updateServiceWorker() 는 인자와 무관하게
  // 대기 SW 에 SKIP_WAITING 을 보내기만 하고, 리로드는 내부 'controlling' 리스너가
  // event.isUpdate(= SW 등록 시점에 이 페이지가 SW 의 통제를 받고 있었는가)일 때만 한다.
  // 하드 리로드·SW 첫 설치 직후처럼 통제받지 않는 페이지(PC 브라우저에서 흔함)에서는
  // 그 리로드가 오지 않고, sw.js 에 clientsClaim 도 없어 controllerchange 자체가 안 뜬다
  // → 새 SW 는 조용히 활성화되는데 화면만 그대로 → 버튼이 먹통으로 보인다.
  // 대기 SW 가 없는 경우(다른 탭이 이미 넘겨받음)도 SKIP_WAITING 이 무응답이므로 같은 증상.
  // 그래서: 컨트롤러 교체를 직접 듣되, 안 오면 타임아웃으로 그냥 리로드한다(새 SW 가 이미
  // 활성이므로 리로드된 페이지가 새 버전을 받는다).
  async function refresh() {
    if (busy) return;
    setBusy(true);
    let done = false;
    const reload = () => { if (!done) { done = true; window.location.reload(); } };
    navigator.serviceWorker?.addEventListener('controllerchange', reload, { once: true });
    setTimeout(reload, CONTROLLER_WAIT_MS);
    await updateServiceWorker();
  }

  if (!needRefresh) return null;

  return (
    <div className="update-toast" role="status" aria-live="polite">
      <span className="update-msg">✨ 새 버전이 나왔어요</span>
      <span className="update-actions">
        <button className="update-yes" onClick={refresh} disabled={busy}>
          {busy ? '적용 중…' : '새로고침'}
        </button>
        <button className="update-no" onClick={() => setNeedRefresh(false)} aria-label="닫기">
          ✕
        </button>
      </span>
    </div>
  );
}
