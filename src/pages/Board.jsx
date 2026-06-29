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
      <header className="page-header">
        <Link to="/boards" className="link-btn">← 게시판</Link>
        <h2>{title}</h2>
        {!isHot && enabled && <button className="link-btn" onClick={() => setWriting((v) => !v)}>{writing ? '닫기' : '글쓰기'}</button>}
      </header>

      {!enabled && (
        <div className="empty">
          <span className="empty-emoji">🚧</span>
          <span>익명게시판이 비활성화되었습니다.</span>
        </div>
      )}

      {writing && !isHot && enabled && (
        <form className="card board-write" onSubmit={submit}>
          <input className="board-title-input" value={pTitle} onChange={(e) => setPTitle(e.target.value)} placeholder="제목" />
          <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="무슨 생각을 하고 있나요?" />
          <label className="board-file-field">
            <span className="board-file-label">📷 이미지 첨부{file ? ` · ${file.name}` : ''}</span>
            <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="삭제용 비밀번호" />
          {err && <p className="error-msg">{err}</p>}
          <button className="btn-add btn-block" disabled={busy}>{busy ? '등록 중…' : '글 등록'}</button>
        </form>
      )}

      {enabled && (
        <>
          <ul className="list">
            {posts.length === 0 && (
              <li className="empty">
                <span className="empty-emoji">📝</span>
                <span>아직 글이 없습니다.{!isHot ? ' 첫 글을 남겨보세요.' : ''}</span>
              </li>
            )}
            {posts.map((p) => (
              <li key={p.id}>
                <Link to={`/board/post/${p.id}`} className="list-row board-post-row">
                  <span className="row-body">
                    <span className="row-title">
                      {p.image_key && <span className="post-img-flag">🖼</span>}
                      <span className="row-title-text">{p.title || '(제목 없음)'}</span>
                      {p.hot && <span className="tag tag-warn">🔥 HOT</span>}
                    </span>
                    <span className="row-snippet">{preview(p.content)}</span>
                    <span className="row-meta">
                      <span className="metric">👍 {p.like_count}</span>
                      <span className="metric">👎 {p.dislike_count}</span>
                      <span className="metric">💬 {p.comment_count}</span>
                    </span>
                  </span>
                  <span className="row-trail"><span className="row-chevron">›</span></span>
                </Link>
              </li>
            ))}
          </ul>

          <div className="pager">
            <button className="btn-ghost btn-sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← 최신</button>
            <span className="pager-now">{page + 1}페이지</span>
            <button className="btn-ghost btn-sm" disabled={posts.length < PAGE_SIZE} onClick={() => setPage((p) => p + 1)}>이전 글 →</button>
          </div>
        </>
      )}
    </div>
  );
}
