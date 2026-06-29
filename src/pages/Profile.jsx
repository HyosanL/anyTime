import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthContext } from '../contexts/AuthContext';
import { changePassword, deleteAccount } from '../lib/auth';
import { supabase } from '../supabase';
import Badge, { badgeOf } from '../components/Badge';

const TIERS = [
  { key: 'gray', label: '그레이', min: 0 },
  { key: 'silver', label: '실버', min: 10 },
  { key: 'gold', label: '골드', min: 50 },
  { key: 'rainbow', label: '레인보우', min: 100 },
];

// 화면8: 레벨/프로필. cadet_level 기준 본인 뱃지 + 다음 등급까지 진행.
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
      <header className="page-header row">
        <Link to="/" className="link-btn">← 홈</Link>
        <h2>프로필</h2>
        <span style={{ width: '2.5rem' }} />
      </header>

      <section className="profile-card">
        <Badge tier={tier} level={count} size={64} />
        <p className="profile-name">{cadet?.username}</p>
        <p className="profile-tier">{TIERS.find((t) => t.key === tier)?.label} · Lv.{count}</p>
      </section>

      <section className="profile-progress">
        {next ? (
          <>
            <div className="progress-head">
              <span>다음 등급 <strong>{next.label}</strong></span>
              <span>{count} / {next.min}</span>
            </div>
            <div className="progress-bar"><span style={{ width: `${pct}%` }} /></div>
            <p className="muted" style={{ fontSize: '0.78rem', marginTop: '0.4rem' }}>
              {next.min - count}회 더 작성하면 {next.label} 등급이 됩니다.
            </p>
          </>
        ) : (
          <p className="muted center">최고 등급(레인보우)에 도달했습니다 🌈</p>
        )}
      </section>

      <section className="profile-tiers">
        {TIERS.map((t) => (
          <div key={t.key} className={`tier-row ${count >= t.min ? 'reached' : ''}`}>
            <Badge tier={t.key} level={t.min} size={22} />
            <span className="tier-label">{t.label}</span>
            <span className="tier-min">{t.min}회+</span>
          </div>
        ))}
      </section>

      <p className="home-todo">강의평·수업메모·족보 작성 +1 / 삭제 −1로 레벨이 오릅니다.</p>

      <section className="account-sec">
        <h3>비밀번호 변경</h3>
        <form className="account-form" onSubmit={onChangePw}>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="새 비밀번호(6자 이상)" autoComplete="new-password" />
          <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="새 비밀번호 확인" autoComplete="new-password" />
          <button type="submit" className="btn-add" disabled={busy}>변경</button>
        </form>
        {pwMsg && <p className="account-msg">{pwMsg}</p>}
      </section>

      <section className="account-sec danger">
        <h3>회원 탈퇴</h3>
        <p className="account-note">탈퇴하면 프로필·확정시간표·레벨 등 계정 정보가 모두 삭제됩니다. (익명으로 남긴 강의평·메모·족보는 작성자 식별 정보가 없어 그대로 유지됩니다.)</p>
        {!confirming ? (
          <button className="btn-danger" onClick={() => { setConfirming(true); setDelMsg(''); }}>회원 탈퇴</button>
        ) : (
          <div className="account-form">
            <input type="password" value={delPw} onChange={(e) => setDelPw(e.target.value)} placeholder="비밀번호 확인" autoComplete="current-password" />
            <button className="btn-danger" onClick={onDelete} disabled={busy}>탈퇴 확정</button>
            <button className="rev-del-btn" onClick={() => { setConfirming(false); setDelPw(''); setDelMsg(''); }}>취소</button>
          </div>
        )}
        {delMsg && <p className="account-msg">{delMsg}</p>}
      </section>
    </div>
  );
}
