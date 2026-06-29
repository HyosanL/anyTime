import { useAuthContext } from '../contexts/AuthContext';
import Badge, { badgeOf } from '../components/Badge';

// M3 시점의 홈 자리표시자. 확정시간표 그리드는 M6에서 구현.
export default function Home() {
  const { cadet, logout } = useAuthContext();
  const count = cadet?.post_count ?? 0;
  const tier = badgeOf(count);

  return (
    <div className="home">
      <header className="home-header">
        <h1>애타</h1>
        <button className="link-btn" onClick={logout}>로그아웃</button>
      </header>

      <section className="home-card">
        <Badge tier={tier} size={64} showLabel />
        <div className="home-card-text">
          <p className="home-hello">
            <strong>{cadet?.username}</strong> 님, 환영합니다
          </p>
          <p className="home-sub">누적 작성 {count}회</p>
        </div>
      </section>

      <p className="home-todo">확정시간표 · 강의평 · 족보는 다음 단계에서 열립니다.</p>
    </div>
  );
}
