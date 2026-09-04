import { useEffect, useRef, useState } from 'react';
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
// - 누르지 않아도 대기 SW 는 (a) 앱을 백그라운드로 보낼 때, (b) 앱을 완전히 닫았다 열 때
//   자동 활성화된다(자동 업데이트 유지). clientsClaim 이 켜져 있어 활성화 즉시 새 SW 가
//   push 까지 처리한다.
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

  // needRefresh 인 채로 앱이 백그라운드로 갈 때 대기 SW 를 조용히 활성화한다(리로드 없음).
  // iOS PWA 는 '앱 완전 종료'가 드물어 대기 SW 가 며칠씩 안 붙는다 → 백그라운드 전환을
  // 활성화 트리거로 쓴다. clientsClaim(vite.config.js) 이 있으므로 활성화 즉시 새 SW 가
  // push 를 처리하고, 다음 포그라운드에서 controllerchange→리로드로 화면도 새 버전이 된다.
  const updateRef = useRef(updateServiceWorker);
  updateRef.current = updateServiceWorker;
  useEffect(() => {
    if (!needRefresh) return undefined;
    const onHide = () => { if (document.visibilityState === 'hidden') updateRef.current(false); };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [needRefresh]);

  // 리로드는 우리가 직접 한다. vite-plugin-pwa 의 updateServiceWorker() 는 인자와 무관하게
  // 대기 SW 에 SKIP_WAITING 을 보내기만 하고, 리로드는 내부 'controlling' 리스너가
  // event.isUpdate(= SW 등록 시점에 이 페이지가 SW 의 통제를 받고 있었는가)일 때만 한다.
  // clientsClaim 이 켜져 있어 새 SW 활성화 시 controllerchange 가 뜨고 아래 reload 가 걸리지만,
  // iOS standalone PWA 등 그 이벤트가 안 오는 경우를 위해 타임아웃 리로드를 남겨 둔다
  // (대기 SW 부재 등으로 SKIP_WAITING 이 무응답인 경우도 같은 폴백으로 처리).
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
