// 위치 권한 켜는 방법 안내 시트 — 권한을 거부해 둔 사용자가 가입/재인증을 못 하는
// 문제 대응. 플랫폼(iOS·삼성 인터넷·Chrome 등)을 감지해 해당 경로만 보여준다.
// ios-guide(설치 안내 시트) 스타일을 재사용한다.

// iOS(아이폰/아이패드) 여부. iPadOS 13+ 는 데스크톱 사파리로 위장하므로 터치로 보정.
function isIos() {
  const ua = window.navigator.userAgent;
  const iOSDevice = /iphone|ipad|ipod/i.test(ua);
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return iOSDevice || iPadOS;
}

// 삼성 인터넷 여부. UA 에 Chrome/ 도 함께 들어 있으므로 SamsungBrowser 로 판별.
function isSamsungInternet() {
  return /SamsungBrowser/i.test(window.navigator.userAgent);
}

function IosSteps() {
  return (
    <ol className="ios-steps">
      <li>
        아이폰 <b>설정</b> → <b>개인정보 보호 및 보안</b> → <b>위치 서비스</b>가
        켜져 있는지 확인하세요.
      </li>
      <li>
        같은 화면의 목록에서 <b>Safari 웹사이트</b> → <b>“앱을 사용하는 동안”</b>
        (또는 “다음번에 묻기”)을 선택하세요.
      </li>
      <li>
        사파리에서 “허용 안 함”을 눌렀었다면: 주소창의 <b>ᴀA</b>(또는 ⋯ 페이지 메뉴) →{' '}
        <b>웹 사이트 설정</b> → <b>위치</b> → <b>허용</b>으로 바꾸세요.
      </li>
      <li>
        홈 화면에 추가한 앱에서 계속 안 되면: 앱을 길게 눌러 <b>삭제</b>한 뒤,
        사파리에서 다시 접속해 위치를 허용하고 <b>홈 화면에 다시 추가</b>하세요.
        (권한이 초기화돼요)
      </li>
    </ol>
  );
}

function SamsungSteps() {
  return (
    <ol className="ios-steps">
      <li>화면 맨 위를 쓸어내려 빠른 설정에서 <b>위치</b>(GPS)를 켜세요.</li>
      <li>
        주소창의 <b>자물쇠 🔒</b> → <b>권한</b> → <b>위치</b>를 <b>허용</b>으로 바꾸세요.
      </li>
      <li>
        안 보이면: 메뉴 <b>≡</b> → <b>설정</b> → <b>사이트 및 다운로드</b> →{' '}
        <b>사이트 권한</b> → <b>위치</b>에서 이 사이트의 차단을 해제하세요.
      </li>
    </ol>
  );
}

function AndroidSteps() {
  return (
    <ol className="ios-steps">
      <li>화면 맨 위를 쓸어내려 빠른 설정에서 <b>위치</b>(GPS)를 켜세요.</li>
      <li>
        주소창의 <b>자물쇠 🔒</b>(또는 설정 아이콘) → <b>권한</b> → <b>위치</b>를{' '}
        <b>허용</b>으로 바꾸세요.
      </li>
      <li>
        홈 화면에 설치한 앱이면: 기기 <b>설정</b> → <b>애플리케이션</b> → <b>애타</b> →{' '}
        <b>권한</b> → <b>위치</b> → <b>앱 사용 중에만 허용</b>을 선택하세요.
      </li>
      <li>
        그래도 안 되면 Chrome <b>⋮</b> → <b>설정</b> → <b>사이트 설정</b> →{' '}
        <b>위치</b>에서 차단 목록에 이 사이트가 있는지 확인하세요.
      </li>
    </ol>
  );
}

export default function LocationHelp({ onClose }) {
  const ios = isIos();
  const samsung = !ios && isSamsungInternet();
  return (
    <div className="ios-guide-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="ios-guide" onClick={(e) => e.stopPropagation()}>
        <h3>📍 위치 권한 켜는 방법</h3>
        {ios ? <IosSteps /> : samsung ? <SamsungSteps /> : <AndroidSteps />}
        <p className="note">
          설정을 바꾼 뒤 이 화면으로 돌아와 다시 시도해주세요. 그래도 안 되면
          앱(브라우저)을 완전히 닫았다가 다시 열어주세요.
        </p>
        <button className="install-yes ios-guide-close" onClick={onClose}>확인</button>
      </div>
    </div>
  );
}
