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

// 삼성 인터넷 여부. UA 에 Chrome/ 도 함께 들어 있으므로 SamsungBrowser 로 판별.
function isSamsungInternet() {
  return /SamsungBrowser/i.test(window.navigator.userAgent);
}

// PWA 설치 안내
// - Android/Chrome 등: beforeinstallprompt 를 잡아 "설치" 버튼으로 즉시 설치
// - 삼성 인터넷: beforeinstallprompt 미지원(이벤트가 안 옴) → 설치 버튼이 못 뜬다.
//   Chrome 으로 열어 설치하는 쪽이 WebAPK(진짜 앱 설치)·푸시 안정성 면에서 낫기도
//   해서, intent:// 링크로 Chrome 에서 열도록 유도한다.
// - iOS(Safari): beforeinstallprompt 미지원 → 수동 안내(iOS 는 설치 API 자체가 없음).
//   iOS 26 실제 경로: ⋯(더보기) → 공유 → (목록 내려서) 홈 화면에 추가 → 추가.
//   공유 시트는 건너뛸 수 없다. 다만 iOS 26 부터 "웹 앱으로 열기"가 기본 ON 이라
//   마지막은 토글 없이 "추가"만 누르면 앱처럼 열린다.
export default function InstallPrompt() {
  const [deferred, setDeferred] = useState(null);
  const [showIosGuide, setShowIosGuide] = useState(false);
  const [showSamsungGuide, setShowSamsungGuide] = useState(false);
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem('installDismissed') === '1'
  );

  const ios = isIos();
  const samsung = !ios && isSamsungInternet();

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
  // iOS·삼성 인터넷이 아니면서 설치 프롬프트도 아직 없으면 띄울 게 없다.
  if (!ios && !samsung && !deferred) return null;

  async function install() {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  }

  function close() {
    setDismissed(true);
    setShowIosGuide(false);
    setShowSamsungGuide(false);
    localStorage.setItem('installDismissed', '1');
  }

  // 삼성 인터넷 → Chrome 으로 현재 페이지 열기(안드로이드 intent 링크).
  // Chrome 미설치면 Play 스토어의 Chrome 페이지가 열린다.
  function openInChrome() {
    const { host, pathname, search } = window.location;
    window.location.href =
      `intent://${host}${pathname}${search}#Intent;scheme=https;package=com.android.chrome;end`;
  }

  return (
    <>
      <div className="install-banner">
        <span>애타를 홈 화면에 추가하면 앱처럼 쓰고, 댓글 푸시 알림도 받을 수 있어요.</span>
        <span className="install-actions">
          {ios ? (
            <button className="install-yes" onClick={() => setShowIosGuide(true)}>
              설치 방법
            </button>
          ) : samsung ? (
            <button className="install-yes" onClick={() => setShowSamsungGuide(true)}>
              설치 방법
            </button>
          ) : (
            <button className="install-yes" onClick={install}>설치</button>
          )}
          <button className="install-no" onClick={close} aria-label="닫기">✕</button>
        </span>
      </div>

      {showSamsungGuide && (
        <div
          className="ios-guide-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => setShowSamsungGuide(false)}
        >
          <div className="ios-guide" onClick={(e) => e.stopPropagation()}>
            <h3>홈 화면에 추가하기</h3>
            <p className="note" style={{ marginBottom: '0.9rem' }}>
              삼성 인터넷에서는 설치 버튼이 지원되지 않아요. <b>Chrome</b>으로 설치하면
              진짜 앱처럼 설치되고 푸시 알림도 더 안정적으로 와요.
            </p>
            <button className="install-yes btn-block" onClick={openInChrome}>
              Chrome으로 열기
            </button>
            <ol className="ios-steps" style={{ marginTop: '0.9rem' }}>
              <li>Chrome에서 애타가 열리면 로그인하세요.</li>
              <li>
                화면 아래 <b>설치</b> 배너 또는 메뉴 <b>⋮</b> → <b>“홈 화면에 추가”</b> 를 누르세요.
              </li>
            </ol>
            <p className="note">
              Chrome이 없다면 삼성 인터넷 메뉴(≡) → <b>현재 페이지 추가</b> → <b>홈 화면</b>으로도
              추가할 수 있어요.
            </p>
            <button
              className="install-yes ios-guide-close"
              onClick={() => setShowSamsungGuide(false)}
            >
              확인
            </button>
          </div>
        </div>
      )}

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
                주소창 오른쪽의 <b>더보기 <MoreIcon /></b> 를 누르세요.
              </li>
              <li>
                메뉴에서 <b>공유 <IosShareIcon /></b> 를 누르세요.
              </li>
              <li>
                목록을 아래로 내려 <b>“홈 화면에 추가”</b> 를 누르세요.
              </li>
              <li>
                <b>“추가”</b> 를 누르면 끝이에요. 애타가 자동으로 앱처럼 열려요.
              </li>
            </ol>
            <p className="note">
              사파리(Safari)에서만 추가할 수 있어요. 다른 앱으로 열었다면 사파리로 다시 열어주세요.
            </p>
            <p className="note">
              🔔 설치하면 내 글에 댓글이 달릴 때 <b>푸시 알림</b>을 받을 수 있어요.
              (게시글의 🔔 버튼 또는 프로필 → 푸시 알림에서 켜기)
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

// iOS 더보기 아이콘(원 안의 점 3개 — 주소창 옆 ⋯ 버튼).
function MoreIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      style={{ verticalAlign: '-3px' }}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="7.4" cy="12" r="1.5" stroke="none" />
      <circle cx="12" cy="12" r="1.5" stroke="none" />
      <circle cx="16.6" cy="12" r="1.5" stroke="none" />
    </svg>
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
