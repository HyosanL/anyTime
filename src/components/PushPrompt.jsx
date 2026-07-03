import { useState } from 'react';
import { useAuthContext } from '../contexts/AuthContext';
import { pushSupported, pushEnabled, enablePush } from '../lib/push';

const DISMISS_KEY = 'pushPromptDismissed';

// 홈 화면 앱(standalone) 여부 — 설치 전 브라우저에서는 InstallPrompt 가 설치를
// 먼저 유도하므로(배너 중복 방지), 알림 배너는 설치된 앱에서만 띄운다.
function isStandalone() {
  return (
    window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  );
}

// 알림 권한이 아직 없을 때(기본 상태) 켜기를 유도하는 배너.
// 권한 프롬프트는 사용자 제스처에서만 요청하는 게 브라우저 정책상 안전하므로
// 자동 요청 대신 "알림 켜기" 버튼 클릭 → enablePush() 로 요청한다.
export default function PushPrompt() {
  const { session } = useAuthContext();
  // 자격은 마운트 시 1회 판정 — 권한 상태가 중간에 바뀌어도(허용/거부 직후)
  // 결과 메시지를 보여줄 수 있게 show 상태로만 닫는다.
  const [show, setShow] = useState(
    () =>
      localStorage.getItem(DISMISS_KEY) !== '1' &&
      isStandalone() &&
      pushSupported() &&
      Notification.permission === 'default' &&
      !pushEnabled()
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  if (!session || !show) return null;

  function close() {
    setShow(false);
    localStorage.setItem(DISMISS_KEY, '1');
  }

  async function turnOn() {
    setBusy(true);
    const r = await enablePush();
    setBusy(false);
    if (r === 'ON') { close(); return; }
    if (r === 'DENIED') setMsg('알림 권한이 거부됐어요. 기기 설정에서 애타의 알림을 허용하면 받을 수 있어요.');
    else setMsg('알림 설정에 실패했어요. 프로필 → 푸시 알림에서 다시 시도해주세요.');
  }

  return (
    <div className="install-banner">
      <span>
        {msg || (
          <>🔔 내 글에 댓글이 달리면 <b>푸시 알림</b>으로 알려드려요. 알림을 켜볼까요?</>
        )}
      </span>
      <span className="install-actions">
        {!msg && (
          <button className="install-yes" onClick={turnOn} disabled={busy}>
            {busy ? '켜는 중…' : '알림 켜기'}
          </button>
        )}
        <button className="install-no" onClick={close} aria-label="닫기">✕</button>
      </span>
    </div>
  );
}
