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
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load(q)} placeholder="게시판 검색 후 Enter" />
      </div>

      {q.trim() && !exact && (
        <div className="board-create">
          <span className="board-create-text">'{q.trim()}' 게시판이 없나요?<br />새로 만들어 첫 글을 남겨보세요.</span>
          <button className="btn-add btn-sm" onClick={async () => { const id = await createBoard(q.trim()); if (id) navigate(`/board/${id}`); }}>새 게시판 만들기</button>
        </div>
      )}

      <ul className="list">
        <li>
          <Link to="/board/hot" className="list-row board-row-hot">
            <span className="row-lead board-lead-hot">🔥</span>
            <span className="row-body">
              <span className="row-title"><span className="row-title-text">HOT 게시판</span><span className="tag tag-warn">인기</span></span>
              <span className="row-sub">지금 가장 화제인 글 모아보기</span>
            </span>
            <span className="row-trail"><span className="row-chevron">›</span></span>
          </Link>
        </li>

        {sorted.map((b) => {
          const isFav = favSet.has(b.id);
          const initial = (b.name || '#').trim().charAt(0) || '#';
          return (
            <li key={b.id}>
              <Link to={`/board/${b.id}`} className="list-row">
                <span className="row-lead">{initial}</span>
                <span className="row-body">
                  <span className="row-title"><span className="row-title-text">{b.name}</span></span>
                </span>
                <span className="row-trail">
                  <button
                    className={`fav-btn${isFav ? ' on' : ''}`}
                    onClick={(e) => { e.preventDefault(); toggleFav(b.id, isFav); }}
                    title="즐겨찾기"
                  >{isFav ? '★' : '☆'}</button>
                  <span className="row-chevron">›</span>
                </span>
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
