import { useEffect, useState } from 'react';

// =====================================================================
//  PWA 설치 게이트 — 모바일에서는 홈 화면 앱(standalone)으로만 사용 가능.
//  설치 전 브라우저 접근이면 앱 대신 전면 설치 화면을 보여준다(강제).
//  - Android/Chrome: beforeinstallprompt → "앱 설치하기" 버튼으로 즉시 설치
//  - 삼성 인터넷: 설치 API 미지원 → intent:// 로 Chrome 열기 유도
//  - iOS: 설치 API 없음 → 공유 → 홈 화면에 추가 수동 안내
//  데스크톱은 게이트하지 않는다(관리자 화면 등 데스크톱 사용 + 설치 미지원
//  브라우저에서 앱이 완전히 잠기는 것 방지). 개발 모드(DEV)도 통과.
// =====================================================================

// iOS(아이폰/아이패드) 여부. iPadOS 13+ 는 데스크톱 사파리로 위장하므로 터치로 보정.
function isIos() {
  const ua = window.navigator.userAgent;
  const iOSDevice = /iphone|ipad|ipod/i.test(ua);
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return iOSDevice || iPadOS;
}

// 이미 홈 화면 앱(standalone)으로 실행 중인가.
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

function isMobile() {
  return isIos() || /android/i.test(window.navigator.userAgent);
}

// 삼성 인터넷 등 → Chrome 으로 현재 페이지 열기(안드로이드 intent 링크).
// Chrome 미설치면 Play 스토어의 Chrome 페이지가 열린다.
function openInChrome() {
  const { host, pathname, search } = window.location;
  window.location.href =
    `intent://${host}${pathname}${search}#Intent;scheme=https;package=com.android.chrome;end`;
}

export default function InstallGate({ children }) {
  const [deferred, setDeferred] = useState(null);
  const [installed, setInstalled] = useState(false);

  // 설치 여부는 세션 동안 불변(standalone 은 실행 방식) → 마운트 시 1회 판정.
  const gated = !import.meta.env.DEV && isMobile() && !isStandalone();

  useEffect(() => {
    if (!gated) return;
    function onPrompt(e) {
      e.preventDefault();
      setDeferred(e);
    }
    function onInstalled() {
      setDeferred(null);
      setInstalled(true);
    }
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, [gated]);

  if (!gated) return <>{children}</>;

  const ios = isIos();
  const samsung = !ios && isSamsungInternet();

  async function install() {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    setDeferred(null); // 거절했으면 아래 수동 안내로 전환(이벤트는 재사용 불가)
  }

  return (
    <div className="install-gate">
      <div className="install-gate-head">
        <span className="onboarding-logo">애</span>
        <h1 className="onboarding-title">애타</h1>
        <p className="install-gate-sub">
          애타는 홈 화면에 설치해서 쓰는 앱이에요.
          <br />
          설치하면 댓글 푸시 알림도 받을 수 있어요.
        </p>
      </div>

      {installed ? (
        <p className="status-msg">
          ✅ 설치 완료! 홈 화면에서 <b>애타</b> 아이콘을 눌러 실행해주세요.
        </p>
      ) : ios ? (
        <div className="install-gate-steps">
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
              <b>“추가”</b> 를 누른 뒤, 홈 화면의 <b>애타</b> 아이콘으로 실행하세요.
            </li>
          </ol>
          <p className="note">
            사파리(Safari)에서만 추가할 수 있어요. 다른 앱으로 열었다면 사파리로 다시 열어주세요.
          </p>
        </div>
      ) : deferred ? (
        <button className="btn-add btn-lg" onClick={install}>📲 앱 설치하기</button>
      ) : samsung ? (
        <div className="install-gate-steps">
          <button className="btn-add btn-lg" onClick={openInChrome}>Chrome으로 열기</button>
          <p className="note">
            삼성 인터넷에서는 설치 버튼이 지원되지 않아요. <b>Chrome</b>에서 열고
            화면의 <b>설치</b> 버튼을 눌러주세요.
            <br />
            (삼성 인터넷으로 설치하려면: 메뉴 <b>≡</b> → <b>현재 페이지 추가</b> → <b>홈 화면</b>)
          </p>
        </div>
      ) : (
        <div className="install-gate-steps">
          <p className="note">
            Chrome 메뉴 <b>⋮</b> → <b>“홈 화면에 추가(앱 설치)”</b> 를 눌러 설치해주세요.
          </p>
          <button className="btn-ghost" onClick={openInChrome}>Chrome으로 열기</button>
        </div>
      )}

      <p className="note install-gate-installed">
        이미 설치했다면 홈 화면의 <b>애타</b> 아이콘으로 열어주세요.
      </p>
    </div>
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
