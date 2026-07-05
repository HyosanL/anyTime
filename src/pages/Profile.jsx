import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthContext } from '../contexts/AuthContext';
import { changePassword, deleteAccount } from '../lib/auth';
import { supabase } from '../supabase';
import { pushSupported, pushEnabled, enablePush, disablePush, hotAlertsOn, setHotAlerts } from '../lib/push';
import Badge, { badgeOf } from '../components/Badge';
import ThemeToggle from '../components/ThemeToggle';
import BackButton from '../components/BackButton';

const TIERS = [
  { key: 'bronze', label: '브론즈', min: 0 },
  { key: 'silver', label: '실버', min: 20 },
  { key: 'gold', label: '골드', min: 100 },
  { key: 'rainbow', label: '레인보우', min: 200 },
];

// 푸시 알림 설정(기기별). 익명 유지: 서버엔 이 기기의 구독 endpoint 만 등록되고
// 계정과 연결되지 않는다. 지원 안 되는 환경(사파리 탭 등)엔 설치 안내를 보여준다.
function PushSettings() {
  const supported = pushSupported();
  const [on, setOn] = useState(() => pushEnabled());
  const [hot, setHot] = useState(() => hotAlertsOn());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function toggle() {
    setBusy(true); setMsg('');
    if (on) {
      await disablePush();
      setOn(false);
    } else {
      const r = await enablePush();
      if (r === 'ON') setOn(true);
      else if (r === 'DENIED') setMsg('알림 권한이 꺼져 있어요. 기기 설정에서 애타의 알림을 허용해주세요.');
      else setMsg('알림 설정에 실패했습니다. 잠시 후 다시 시도해주세요.');
    }
    setBusy(false);
  }

  function toggleHot(e) {
    const v = e.target.checked;
    setHot(v);
    setHotAlerts(v).catch(() => {});
  }

  return (
    <section className="card account-sec">
      <h3 className="account-sec-title">푸시 알림</h3>
      {!supported ? (
        <p className="account-note">
          이 브라우저에서는 푸시 알림을 받을 수 없어요. 애타를 <b>홈 화면에 설치</b>하면
          (아이폰: Safari 공유 → 홈 화면에 추가) 댓글 알림을 받을 수 있습니다.
        </p>
      ) : (
        <>
          <p className="account-note">
            내가 쓴 글·댓글 단 글에 새 댓글이 달리면 알려드려요. 게시글의 🔔 버튼으로
            글마다 켜고 끌 수 있습니다. (알림은 이 기기에만 연결되며 계정과 연결되지 않아요.)
          </p>
          <button className={on ? 'btn-danger-soft btn-block' : 'btn-add btn-block'} onClick={toggle} disabled={busy}>
            {on ? '푸시 알림 끄기' : '푸시 알림 켜기'}
          </button>
          {on && (
            <>
              <label className="account-note" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                <input type="checkbox" checked={hot} onChange={toggleHot} />
                🔥 HOT 승격 게시글 알림 받기
              </label>
              {/* Android(삼성 등)는 사이트 알림 채널 중요도가 '기본'이라 팝업 없이
                  알림센터로만 들어가는 경우가 있다 — 중요도는 코드로 못 올려서 안내로 보완 */}
              {/android/i.test(navigator.userAgent) && (
                <p className="account-note" style={{ marginTop: 8 }}>
                  💡 알림이 화면에 <b>팝업으로 안 뜨고</b> 알림센터에만 조용히 쌓이면:
                  도착한 알림을 <b>길게 눌러</b> 알림 설정에서 <b>‘소리 및 팝업’(중요도 높음)</b>으로
                  바꿔주세요. 또는 기기 <b>설정 → 알림 → Chrome(또는 애타)</b>에서 이 사이트
                  알림의 표시 방식을 높여주세요.
                </p>
              )}
            </>
          )}
          {msg && <p className="account-msg">{msg}</p>}
        </>
      )}
    </section>
  );
}

// 화면8: 레벨/프로필. cadet.post_count 기준 본인 뱃지(badgeOf) + 다음 등급까지 진행.
export default function Profile() {
  const { cadet } = useAuthContext();
  const navigate = useNavigate();
  const count = cadet?.post_count ?? 0;
  const tier = badgeOf(count);

  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [pwMsg, setPwMsg] = useState('');
  const [delPw, setDelPw] = useState('');
  const [delMsg, setDelMsg] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onChangePw(e) {
    e.preventDefault();
    setPwMsg('');
    if (pw.length < 6) return setPwMsg('비밀번호는 6자 이상이어야 합니다.');
    if (pw !== pw2) return setPwMsg('두 비밀번호가 일치하지 않습니다.');
    setBusy(true);
    try {
      await changePassword(pw);
      setPw(''); setPw2('');
      setPwMsg('✅ 비밀번호가 변경되었습니다.');
    } catch (err) {
      setPwMsg(err.message || '변경에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    setDelMsg('');
    if (!delPw) return setDelMsg('비밀번호를 입력하세요.');
    setBusy(true);
    const status = await deleteAccount(delPw);
    setBusy(false);
    if (status === 'OK') {
      await supabase.auth.signOut();
      navigate('/login', { replace: true });
      return;
    }
    setDelMsg(status === 'BAD_PASSWORD' ? '비밀번호가 일치하지 않습니다.' : '탈퇴 처리에 실패했습니다.');
  }

  const next = TIERS.find((t) => t.min > count);
  const curMin = [...TIERS].reverse().find((t) => count >= t.min)?.min ?? 0;
  const pct = next ? Math.round(((count - curMin) / (next.min - curMin)) * 100) : 100;

  return (
    <div className="page">
      <header className="page-header">
        <BackButton />
        <h2>프로필</h2>
      </header>

      <div className="home-body">
        <section className="card profile-card">
          <Badge tier={tier} level={count} size={64} />
          <p className="profile-name">{cadet?.username}</p>
          <p className="profile-tier">{TIERS.find((t) => t.key === tier)?.label} · Lv.{count}</p>

          <div className="profile-progress">
            {next ? (
              <>
                <div className="progress-head">
                  <span>다음 등급 <strong>{next.label}</strong></span>
                  <span>{count} / {next.min}</span>
                </div>
                <div className="progress-bar"><span style={{ width: `${pct}%` }} /></div>
                <p className="note progress-note">
                  {next.min - count}회 더 작성하면 {next.label} 등급이 됩니다.
                </p>
              </>
            ) : (
              <p className="muted center">최고 등급(레인보우)에 도달했습니다 🌈</p>
            )}
          </div>
        </section>

        <section className="card profile-tiers">
          <p className="section-label profile-tiers-label">레벨 등급</p>
          {TIERS.map((t) => (
            <div key={t.key} className={`tier-row ${count >= t.min ? 'reached' : ''}`}>
              <Badge tier={t.key} level={t.min} size={22} />
              <span className="tier-label">{t.label}</span>
              <span className="tier-min">{t.min}회+</span>
            </div>
          ))}
          <p className="note profile-todo">강의평·수업메모·족보 작성 +1 / 삭제 −1로 레벨이 오릅니다.</p>
        </section>

        <section className="card account-sec">
          <h3 className="account-sec-title">화면 테마</h3>
          <p className="account-note">시스템 설정을 따르거나 라이트·다크를 직접 고를 수 있습니다.</p>
          <div className="account-theme">
            <ThemeToggle />
          </div>
        </section>

        <PushSettings />

        <section className="card account-sec">
          <h3 className="account-sec-title">비밀번호 변경</h3>
          <form className="account-form" onSubmit={onChangePw}>
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="새 비밀번호(6자 이상)" autoComplete="new-password" />
            <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="새 비밀번호 확인" autoComplete="new-password" />
            <button type="submit" className="btn-add btn-block" disabled={busy}>변경</button>
          </form>
          {pwMsg && <p className="account-msg">{pwMsg}</p>}
        </section>

        <section className="card account-sec danger">
          <h3 className="account-sec-title">회원 탈퇴</h3>
          <p className="account-note">탈퇴하면 프로필·확정시간표·레벨 등 계정 정보가 모두 삭제됩니다. (익명으로 남긴 강의평·메모·족보는 작성자 식별 정보가 없어 그대로 유지됩니다.)</p>
          {!confirming ? (
            <button className="btn-danger-soft btn-block" onClick={() => { setConfirming(true); setDelMsg(''); }}>회원 탈퇴</button>
          ) : (
            <div className="account-form">
              <input type="password" value={delPw} onChange={(e) => setDelPw(e.target.value)} placeholder="비밀번호 확인" autoComplete="current-password" />
              <button className="btn-danger btn-block" onClick={onDelete} disabled={busy}>탈퇴 확정</button>
              <button className="rev-del-btn" onClick={() => { setConfirming(false); setDelPw(''); setDelMsg(''); }}>취소</button>
            </div>
          )}
          {delMsg && <p className="account-msg">{delMsg}</p>}
        </section>
      </div>
    </div>
  );
}
