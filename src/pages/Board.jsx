import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getBoard, listPosts, listHot, createPost, uploadBoardImage, PAGE_SIZE, boardEnabled } from '../lib/board';
import { maskProfanity } from '../lib/moderation';

export default function Board() {
  const { id } = useParams();
  const isHot = id === 'hot';
  const [title, setTitle] = useState(isHot ? '🔥 HOT' : '게시판');
  const [posts, setPosts] = useState([]);
  const [page, setPage] = useState(0);
  const [writing, setWriting] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [pTitle, setPTitle] = useState('');
  const [content, setContent] = useState('');
  const [password, setPassword] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function load(p) {
    if (isHot) { setPosts(await listHot(p)); setTitle('🔥 HOT'); }
    else { const b = await getBoard(id); setTitle(b?.name || '게시판'); setPosts(await listPosts(id, p)); }
  }
  useEffect(() => { setPage(0); load(0); boardEnabled().then(setEnabled); /* eslint-disable-next-line */ }, [id]);
  useEffect(() => { load(page); /* eslint-disable-next-line */ }, [page]);

  async function submit(e) {
    e.preventDefault(); setErr('');
    if (!pTitle.trim()) return setErr('제목을 입력하세요.');
    if (!content.trim()) return setErr('내용을 입력하세요.');
    if (password.length < 2) return setErr('삭제용 비밀번호를 입력하세요.');
    setBusy(true);
    try {
      let key = null;
      if (file) key = await uploadBoardImage(file);
      await createPost(Number(id), maskProfanity(pTitle.trim()), maskProfanity(content.trim()), password, key);
      setPTitle(''); setContent(''); setPassword(''); setFile(null); setWriting(false);
      if (page === 0) load(0); else setPage(0);
    } catch (e2) { setErr(e2.message || '작성 실패'); }
    setBusy(false);
  }

  const preview = (s) => { const t = (s || '').replace(/\s+/g, ' ').trim(); return t.length > 60 ? t.slice(0, 60) + '…' : t; };

  return (
    <div className="page noscreenshot">
      <header className="page-header row">
        <Link to="/boards" className="link-btn">← 게시판</Link>
        <h2>{title}</h2>
        {!isHot && enabled ? <button className="link-btn" onClick={() => setWriting((v) => !v)}>{writing ? '닫기' : '글쓰기'}</button> : <span style={{ width: '2.5rem' }} />}
      </header>

      {!enabled && <p className="muted center">익명게시판이 비활성화되었습니다.</p>}

      {writing && !isHot && enabled && (
        <form className="board-write" onSubmit={submit}>
          <input className="board-title-input" value={pTitle} onChange={(e) => setPTitle(e.target.value)} placeholder="제목" />
          <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="내용" />
          <div className="board-write-row">
            <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} />
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="삭제용 비번" />
          </div>
          {err && <p className="error-msg">{err}</p>}
          <button className="btn-add" disabled={busy}>{busy ? '등록 중…' : '등록'}</button>
        </form>
      )}

      <ul className="post-list">
        {posts.length === 0 && <p className="muted center">글이 없습니다.</p>}
        {posts.map((p) => (
          <li key={p.id} className="post-item">
            <Link to={`/board/post/${p.id}`}>
              <p className="post-title">{p.image_key ? '🖼 ' : ''}{p.title || '(제목 없음)'}</p>
              <p className="post-preview">{preview(p.content)}</p>
              <div className="post-meta">👍 {p.like_count} · 👎 {p.dislike_count} · 💬 {p.comment_count}{p.hot ? ' · 🔥' : ''}</div>
            </Link>
          </li>
        ))}
      </ul>

      <div className="pager">
        <button className="link-btn" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← 최신</button>
        <span className="muted">{page + 1}페이지</span>
        <button className="link-btn" disabled={posts.length < PAGE_SIZE} onClick={() => setPage((p) => p + 1)}>이전 글 →</button>
      </div>
    </div>
  );
}
