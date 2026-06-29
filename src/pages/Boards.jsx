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
      <header className="page-header row">
        <Link to="/" className="link-btn">← 홈</Link><h2>익명게시판</h2><span style={{ width: '2.5rem' }} />
      </header>
      <div className="search-bar">
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load(q)} placeholder="게시판 검색 후 Enter" />
      </div>
      {q.trim() && !exact && (
        <div className="board-create">
          <span className="muted">'{q.trim()}' 게시판이 없나요?</span>
          <button className="btn-add" onClick={async () => { const id = await createBoard(q.trim()); if (id) navigate(`/board/${id}`); }}>새 게시판 만들기</button>
        </div>
      )}
      <ul className="board-list">
        <li>
          <Link to="/board/hot" className="board-item" style={{ background: '#fff7ed', borderColor: '#fdba74' }}>
            <span className="board-name">🔥 HOT 게시판</span><span className="muted">›</span>
          </Link>
        </li>
        {sorted.map((b) => {
          const isFav = favSet.has(b.id);
          return (
            <li key={b.id} className="board-row">
              <button className="fav-btn" onClick={() => toggleFav(b.id, isFav)} title="즐겨찾기">{isFav ? '★' : '☆'}</button>
              <Link to={`/board/${b.id}`} className="board-item" style={{ flex: 1 }}>
                <span className="board-name">{b.name}</span><span className="muted">›</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
