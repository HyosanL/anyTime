import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listBoards, createBoard, listFavoriteIds, addFavorite, removeFavorite } from '../lib/board';

export default function Boards() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [boards, setBoards] = useState([]);
  const [favs, setFavs] = useState([]);

  async function load(query) {
    setBoards(await listBoards(query));
    setFavs(await listFavoriteIds());
  }
  useEffect(() => { load(''); }, []);

  async function toggleFav(id, isFav) {
    if (isFav) await removeFavorite(id); else await addFavorite(id);
    setFavs(await listFavoriteIds());
  }

  const exact = boards.some((b) => b.name === q.trim());
  const favSet = new Set(favs);
  const sorted = [...boards].sort((a, b) => (favSet.has(b.id) ? 1 : 0) - (favSet.has(a.id) ? 1 : 0));

  return (
    <div className="page noscreenshot">
      <header className="page-header">
        <Link to="/" className="link-btn">← 홈</Link>
        <h2>익명게시판</h2>
      </header>

      <div className="search-bar">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load(q)} placeholder="게시판 검색 후 Enter" />
      </div>

      {!q.trim() && (
        <p className="board-create-hint">💡 찾는 게시판이 없나요? 검색하면 원하는 이름으로 바로 새 게시판을 만들 수 있어요.</p>
      )}

      {q.trim() && !exact && (
        <div className="board-create">
          <span className="board-create-text">'{q.trim()}' 게시판이 없나요?<br />새로 만들어 첫 글을 남겨보세요.</span>
          <button className="btn-add btn-sm" onClick={async () => { const id = await createBoard(q.trim()); if (id) navigate(`/board/${id}`); }}>새 게시판 만들기</button>
        </div>
      )}

      {/* HOT 바로가기 — 디렉터리 상단 강조 */}
      <Link to="/board/hot" className="board-hot-link">
        <span className="board-hot-ic">🔥</span>
        <span className="board-hot-body">
          <span className="board-hot-title">HOT 게시판</span>
          <span className="board-hot-sub">지금 가장 화제인 글 모아보기</span>
        </span>
        <span className="post-chevron">›</span>
      </Link>

      <h3 className="section-label">게시판 목록</h3>
      <ul className="board-dir">
        {sorted.map((b) => {
          const isFav = favSet.has(b.id);
          const initial = (b.name || '#').trim().charAt(0) || '#';
          return (
            <li key={b.id}>
              <Link to={`/board/${b.id}`} className="board-dir-row">
                <span className="board-dir-lead">{initial}</span>
                <span className="board-dir-name">{b.name}</span>
                <button
                  className={`fav-btn${isFav ? ' on' : ''}`}
                  onClick={(e) => { e.preventDefault(); toggleFav(b.id, isFav); }}
                  title="즐겨찾기"
                >{isFav ? '★' : '☆'}</button>
                <span className="post-chevron">›</span>
              </Link>
            </li>
          );
        })}

        {sorted.length === 0 && !q.trim() && (
          <li className="empty">
            <span className="empty-emoji">📭</span>
            <span>아직 게시판이 없습니다.</span>
          </li>
        )}
      </ul>
    </div>
  );
}
