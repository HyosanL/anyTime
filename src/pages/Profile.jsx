import { Link } from 'react-router-dom';
import { useAuthContext } from '../contexts/AuthContext';
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
  const count = cadet?.post_count ?? 0;
  const tier = badgeOf(count);

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
    </div>
  );
}
