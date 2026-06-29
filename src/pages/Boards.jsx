import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listBoards, createBoard } from '../lib/board';

export default function Boards() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [boards, setBoards] = useState([]);

  async function load(query) { setBoards(await listBoards(query)); }
  useEffect(() => { load(''); }, []);

  const exact = boards.some((b) => b.name === q.trim());

  return (
    <div className="page noscreenshot">
      <header className="page-header row">
        <Link to="/" className="link-btn">← 홈</Link>
        <h2>익명게시판</h2>
        <Link to="/board/hot" className="link-btn">🔥 HOT</Link>
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
        {boards.length === 0 && <p className="muted center">게시판이 없습니다. 검색해서 새로 만들어 보세요.</p>}
        {boards.map((b) => (
          <li key={b.id}>
            <Link to={`/board/${b.id}`} className="board-item">
              <span className="board-name">{b.name}</span>
              <span className="muted">›</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
