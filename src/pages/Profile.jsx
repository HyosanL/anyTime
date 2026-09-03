import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthContext } from '../contexts/AuthContext';
import { changePassword, deleteAccount } from '../lib/auth';
import { pushSupported, pushEnabled, enablePush, disablePush, hotAlertsOn, setHotAlerts, getDnd, setDnd, sendTestPush } from '../lib/push';
import { NEXT_CLASS_LEADS, getLead, setLeadPref, syncNextClassAlerts } from '../lib/nextClass';
import { briefOn, setBriefOn, getBriefTime, setBriefTime, syncDailyBrief } from '../lib/dailyBrief';
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
  const [dnd, setDndState] = useState(() => getDnd());
  const [lead, setLeadState] = useState(() => getLead());
  const [brief, setBrief] = useState(() => briefOn());
  const [briefTime, setBriefTimeState] = useState(() => getBriefTime());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [testMsg, setTestMsg] = useState('');

  // 다음 수업 알림 리드타임 변경 — 로컬 저장 후 스케줄을 재계산해 서버(발동 시각만)·
  // 기기 Cache(내용)에 반영한다. 실패는 다음 앱 실행 때 App.jsx PushSync 가 재시도.
  function changeLead(v) {
    setLeadState(v);
    setLeadPref(v);
    syncNextClassAlerts({ force: true }).catch(() => {});
  }

  // "오늘 수업 요약" 켜기/끄기·시각 변경 — 다음 수업 알림과 독립적으로 동작한다.
  function toggleBrief(e) {
    const v = e.target.checked;
    setBrief(v);
    setBriefOn(v);
    syncDailyBrief({ force: true }).catch(() => {});
  }
  function changeBriefTime(v) {
    setBriefTimeState(v);
    setBriefTime(v);
    if (brief) syncDailyBrief({ force: true }).catch(() => {});
  }

  // 방해금지 설정 변경 — 로컬 저장 + SW(Cache) 미러(설정 반영은 다음 알림부터).
  function updateDnd(patch) {
    const next = { ...dnd, ...patch };
    setDndState(next);
    setDnd(next).catch(() => {});
  }

  // 분(0~1439, 음수/초과 자동 순환) → 'HH:MM'
  function hhmmFromMin(m) {
    const x = ((m % 1440) + 1440) % 1440;
    return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
  }

  // 실기기 테스트: 지금 시각을 포함하도록 방해금지 창을 임시 조정한 뒤(입력칸도 즉시 반영),
  // 실제 푸시와 같은 SW 경로로 테스트 알림을 띄운다 → 무음으로 와야 정상.
  // setDnd 를 await 해 Cache 미러 완료 후 발송(레이스 없음). 창은 눈에 보이니 뒤에 직접 되돌리면 된다.
  async function testQuietNow() {
    setTestMsg('');
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const win = { on: true, start: hhmmFromMin(cur - 1), end: hhmmFromMin(cur + 60) };
    setDndState(win);
    try {
      await setDnd(win);   // 로컬+Cache 미러 완료 보장
      await sendTestPush({ kind: 'hot', title: '방해금지 조용히 테스트', board: '테스트', path: '/board/hot' });
      setTestMsg(`방해금지 창을 ${win.start}~${win.end} 로 임시 조정하고 무음 테스트 알림을 보냈어요. 소리·진동 없이 오면 정상이고, 알림을 탭하면 HOT 게시판으로 이동합니다. (테스트 후 위 시간은 원하는 값으로 되돌려 주세요.)`);
    } catch {
      setTestMsg('테스트 알림을 보내지 못했어요. 알림이 켜져 있는지 확인해주세요.');
    }
  }

  // 로컬 테스트 알림 — 알림이 실제로 도착하는지(권한·구독·전송) 확인용.
  // 헤드업(팝업)으로 뜨는지는 기기 설정 소관이라 코드로 못 바꾸므로 판단하지 않는다.
  async function sendTest() {
    setTestMsg('');
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification('🔔 테스트 알림', {
        body: '테스트 알림이 도착했어요.',
        tag: 'push-test',
        renotify: true,
        vibrate: [180, 80, 180],
        icon: '/icons/icon.svg',
      });
      setTestMsg('테스트 알림을 보냈어요.');
    } catch {
      setTestMsg('테스트 알림을 보내지 못했어요. 알림이 켜져 있는지 확인해주세요.');
    }
  }

  // "다음 수업" 알림 미리보기 — SW 버전(업데이트 지연)에 안 기대도록, 실제 서버 핑 경로
  // (sendTestPush→SW showNextClass) 대신 페이지에서 직접 같은 형식으로 알림을 띄운다.
  // 실제 알림은 push-sw.js 의 showNextClass 가 그리며 문구는 여기와 동일하다.
  async function testNextClass() {
    setTestMsg('');
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification('⏰ 다음 수업', {
        body: '선형대수학 · 202 · 08:00',
        tag: 'next-class-preview',
        renotify: true,
        vibrate: [180, 80, 180],
        icon: '/icons/icon.svg',
      });
      setTestMsg('“⏰ 다음 수업 / 선형대수학 · 202 · 08:00” 형식으로 알림이 오면 정상입니다. (실제 알림은 수업 시작 전에 이 형식으로 옵니다.)');
    } catch {
      setTestMsg('테스트 알림을 보내지 못했어요. 알림이 켜져 있는지 확인해주세요.');
    }
  }

  // "오늘 수업 요약" 미리보기 — 실제 알림은 push-sw.js 의 showTodaySummary 가 그날 실제
  // 수업으로 그리며 문구 형식은 여기와 동일하다.
  async function testDailyBrief() {
    setTestMsg('');
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification('🌅 오늘 수업', {
        body: '09:00 경제원론 · 302\n11:00 물리학 · 401',
        tag: 'daily-brief-preview',
        renotify: true,
        vibrate: [180, 80, 180],
        icon: '/icons/icon.svg',
      });
      setTestMsg('“🌅 오늘 수업” 형식으로 알림이 오면 정상입니다. (실제 알림은 설정한 시각에 그날 수업으로 옵니다.)');
    } catch {
      setTestMsg('테스트 알림을 보내지 못했어요. 알림이 켜져 있는지 확인해주세요.');
    }
  }

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
          홈 화면에 설치하면 댓글 알림을 받을 수 있어요. (아이폰: Safari 공유 → 홈 화면에 추가)
        </p>
      ) : (
        <>
          <p className="account-note">
            내 글·댓글에 새 댓글이 달리면 알려드려요. 이 기기에만 연결돼요.
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

              <label className="account-note" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                <input type="checkbox" checked={dnd.on} onChange={(e) => updateDnd({ on: e.target.checked })} />
                🌙 방해금지 시간 (이 시간엔 소리·진동 없이 조용히)
              </label>
              {dnd.on && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, marginLeft: 22 }}>
                  <label className="account-note" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    시작 <input type="time" value={dnd.start} onChange={(e) => updateDnd({ start: e.target.value })} />
                  </label>
                  <label className="account-note" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    종료 <input type="time" value={dnd.end} onChange={(e) => updateDnd({ end: e.target.value })} />
                  </label>
                </div>
              )}
              {dnd.on && (
                <p className="account-note" style={{ marginTop: 6 }}>
                  이 시간대엔 소리·진동 없이 알림센터로만 조용히 도착해요.
                </p>
              )}

              <div className="account-note" style={{ marginTop: 12 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={brief} onChange={toggleBrief} />
                  🌅 오늘 수업 요약 <span className="muted">(다음 수업 알림과 별개 · 방해금지 무시)</span>
                </label>
                {brief && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, marginLeft: 22 }}>
                    발송 시각 <input type="time" step="300" value={briefTime} onChange={(e) => changeBriefTime(e.target.value)} />
                  </div>
                )}
                <p className="account-note" style={{ marginTop: 6 }}>
                  매일 지정 시각에 그날 수업을 요약해 드려요. 수업 없는 날은 오지 않아요.
                </p>
              </div>

              <div className="account-note" style={{ marginTop: 12 }}>
                <div style={{ marginBottom: 5 }}>⏰ 다음 수업 알림 <span className="muted">(확정 시간표 기준 · 방해금지 무시)</span></div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {NEXT_CLASS_LEADS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={n === lead ? 'btn-add btn-sm' : 'btn-ghost btn-sm'}
                      onClick={() => changeLead(n)}
                    >
                      {n === 0 ? '끄기' : `${n}분 전`}
                    </button>
                  ))}
                </div>
                <p className="account-note" style={{ marginTop: 6 }}>
                  수업 시작 전 과목·강의실을 알려드려요. 과목·강의실은 서버에 저장되지 않아요.
                </p>
              </div>

              <details className="account-test">
                <summary>알림 테스트</summary>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                  <button className="btn-ghost btn-sm" onClick={sendTest}>🔔 테스트 알림</button>
                  <button className="btn-ghost btn-sm" onClick={testQuietNow}>🌙 무음 테스트</button>
                  <button className="btn-ghost btn-sm" onClick={testNextClass}>⏰ 다음 수업</button>
                  <button className="btn-ghost btn-sm" onClick={testDailyBrief}>🌅 오늘 수업</button>
                </div>
                {testMsg && <p className="account-note" style={{ marginTop: 6 }}>{testMsg}</p>}
              </details>
            </>
          )}
          {msg && <p className="account-msg">{msg}</p>}
        </>
      )}
    </section>
  );
}

// 화면8: 레벨/프로필. cadet.postCount 기준 본인 뱃지(badgeOf) + 다음 등급까지 진행.
export default function Profile() {
  const { cadet, logout } = useAuthContext();
  const navigate = useNavigate();
  const count = cadet?.postCount ?? 0;
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
      // 민감한 작업이라 Firebase 가 최근 재로그인을 요구할 수 있다(Supabase 엔 없던 제약).
      setPwMsg(err.code === 'auth/requires-recent-login'
        ? '보안을 위해 다시 로그인한 뒤 시도해주세요.'
        : err.message || '변경에 실패했습니다.');
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
      await logout();
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

        <PushSettings />

        <section className="card account-sec">
          <h3 className="account-sec-title">화면 테마</h3>
          <div className="account-theme">
            <ThemeToggle />
          </div>
        </section>

        <section className="card account-sec anon-sec">
          <h3 className="account-sec-title">🔒 이 앱의 익명성</h3>
          <p className="anon-lead">
            애타는 <b>누가 무엇을 썼는지</b> 앱 자체가 알 수 없도록 설계돼 있어요.
            강의평·수업메모·족보·게시글은 작성자 정보 없이 저장되고, 삭제는 글 비밀번호로 합니다.
          </p>
          <details className="anon-more">
            <summary>자세히</summary>
            <ul className="anon-list">
              <li><b>글에 작성자가 남지 않아요.</b> 게시글·강의평 데이터에는 내용과 시각만 저장되고, 누가 썼는지를 가리키는 정보가 아예 없습니다.</li>
              <li><b>실명·전화번호를 받지 않아요.</b> 가입은 아이디·비밀번호만으로 이뤄지고 이메일·전화·실명은 수집하지 않습니다.</li>
              <li><b>관리자도 작성자를 특정할 수 없어요.</b> 데이터를 전부 열람해도 “이 글을 누가 썼는지”는 나오지 않습니다. 신고가 쌓이면 내용만 자동으로 가려질 뿐입니다.</li>
              <li><b>삭제는 글 비밀번호로 해요.</b> 계정 소유로 지우는 게 아니라 글마다 정한 삭제 비밀번호로 지웁니다.</li>
            </ul>
            <p className="anon-caveat">
              ⚠️ 다만 이건 <b>학교·관리자·다른 생도로부터의 익명성</b>이에요.
              명예훼손·협박 같은 불법 콘텐츠는 다른 인터넷 서비스와 마찬가지로,
              법적 절차(수사기관의 IP·통신기록 조회 등)에 따라 추적 대상이 될 수 있습니다.
              서로 존중하며 이용해주세요.
            </p>
          </details>
        </section>

        <section className="card account-sec">
          <h3 className="account-sec-title">계정</h3>
          <form className="account-form" onSubmit={onChangePw}>
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="새 비밀번호(6자 이상)" autoComplete="new-password" />
            <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="새 비밀번호 확인" autoComplete="new-password" />
            <button type="submit" className="btn-add btn-block" disabled={busy}>비밀번호 변경</button>
          </form>
          {pwMsg && <p className="account-msg">{pwMsg}</p>}
          <button type="button" className="btn-ghost btn-block" style={{ marginTop: 10 }} onClick={logout}>로그아웃</button>
        </section>

        <section className="card account-sec danger">
          <h3 className="account-sec-title">회원 탈퇴</h3>
          <p className="account-note">프로필·시간표·레벨이 삭제됩니다. 익명으로 남긴 강의평·메모·족보·글은 그대로 유지돼요.</p>
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
