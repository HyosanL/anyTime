import { useAuthContext } from '../contexts/AuthContext';

const BADGE = { gray: '🩶', silver: '🥈', gold: '🥇', rainbow: '🌈' };

function badgeOf(count) {
  if (count >= 100) return 'rainbow';
  if (count >= 50) return 'gold';
  if (count >= 10) return 'silver';
  return 'gray';
}

// M3 시점의 홈 자리표시자. 확정시간표 그리드는 M6에서 구현.
export default function Home() {
  const { cadet, logout } = useAuthContext();
  const badge = badgeOf(cadet?.post_count ?? 0);

  return (
    <div className="home">
      <header className="home-header">
        <h1>애타</h1>
        <button className="link-btn" onClick={logout}>로그아웃</button>
      </header>

      <section className="home-card">
        <p className="home-hello">
          <strong>{cadet?.username}</strong> 님, 환영합니다 {BADGE[badge]}
        </p>
        <p className="home-sub">누적 작성 {cadet?.post_count ?? 0}회 · 등급 {badge}</p>
      </section>

      <p className="home-todo">확정시간표 · 강의평 · 족보는 다음 단계에서 열립니다.</p>
    </div>
  );
}
