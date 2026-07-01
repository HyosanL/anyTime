import { useEffect, useState } from 'react';

// iOS(아이폰/아이패드) 여부. iPadOS 13+ 는 데스크톱 사파리로 위장하므로 터치로 보정.
function isIos() {
  const ua = window.navigator.userAgent;
  const iOSDevice = /iphone|ipad|ipod/i.test(ua);
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return iOSDevice || iPadOS;
}

// 이미 홈 화면 앱(standalone)으로 실행 중이면 설치 안내 불필요.
function isStandalone() {
  return (
    window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  );
}

// PWA 설치 안내
// - Android/Chrome 등: beforeinstallprompt 를 잡아 "설치" 버튼으로 즉시 설치
// - iOS(Safari): beforeinstallprompt 미지원 → "공유 → 홈 화면에 추가" 수동 안내
export default function InstallPrompt() {
  const [deferred, setDeferred] = useState(null);
  const [showIosGuide, setShowIosGuide] = useState(false);
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem('installDismissed') === '1'
  );

  const ios = isIos();

  useEffect(() => {
    function onPrompt(e) {
      e.preventDefault();
      setDeferred(e);
    }
    function onInstalled() {
      setDeferred(null);
    }
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // 이미 설치했거나 사용자가 닫았으면 배너를 띄우지 않는다.
  if (dismissed || isStandalone()) return null;
  // iOS 가 아니면서 설치 프롬프트도 아직 없으면 띄울 게 없다.
  if (!ios && !deferred) return null;

  async function install() {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  }

  function close() {
    setDismissed(true);
    setShowIosGuide(false);
    localStorage.setItem('installDismissed', '1');
  }

  return (
    <>
      <div className="install-banner">
        <span>애타를 홈 화면에 추가하면 앱처럼 쓸 수 있어요.</span>
        <span className="install-actions">
          {ios ? (
            <button className="install-yes" onClick={() => setShowIosGuide(true)}>
              설치 방법
            </button>
          ) : (
            <button className="install-yes" onClick={install}>설치</button>
          )}
          <button className="install-no" onClick={close} aria-label="닫기">✕</button>
        </span>
      </div>

      {showIosGuide && (
        <div
          className="ios-guide-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => setShowIosGuide(false)}
        >
          <div className="ios-guide" onClick={(e) => e.stopPropagation()}>
            <h3>홈 화면에 추가하기</h3>
            <ol className="ios-steps">
              <li>
                사파리 아래(또는 위)의 <b>공유 버튼 <IosShareIcon /></b> 을 누르세요.
              </li>
              <li>
                메뉴를 내려 <b>“홈 화면에 추가”</b> 를 선택하세요.
              </li>
              <li>
                오른쪽 위 <b>“추가”</b> 를 누르면 완료예요.
              </li>
            </ol>
            <p className="note">
              사파리(Safari)에서만 추가할 수 있어요. 다른 앱으로 열었다면 사파리로 다시 열어주세요.
            </p>
            <button
              className="install-yes ios-guide-close"
              onClick={() => setShowIosGuide(false)}
            >
              확인
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// iOS 공유 아이콘(네모 상자 + 위로 향한 화살표).
function IosShareIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ verticalAlign: '-2px' }}
      aria-hidden="true"
    >
      <path d="M12 15V3" />
      <path d="M8 7l4-4 4 4" />
      <path d="M6 12H4v8h16v-8h-2" />
    </svg>
  );
}
