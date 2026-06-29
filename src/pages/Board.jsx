import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getBoard, listPosts, listHot, createPost, uploadBoardImage } from '../lib/board';
import { maskProfanity } from '../lib/moderation';
import BoardImage from '../components/BoardImage';

export default function Board() {
  const { id } = useParams();
  const isHot = id === 'hot';
  const [title, setTitle] = useState(isHot ? '🔥 HOT' : '게시판');
  const [posts, setPosts] = useState([]);
  const [content, setContent] = useState('');
  const [password, setPassword] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function load() {
    if (isHot) { setPosts(await listHot()); setTitle('🔥 HOT'); }
    else { const b = await getBoard(id); setTitle(b?.name || '게시판'); setPosts(await listPosts(id)); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  async function submit(e) {
    e.preventDefault(); setErr('');
    if (!content.trim()) return setErr('내용을 입력하세요.');
    if (password.length < 2) return setErr('삭제용 비밀번호를 입력하세요.');
    setBusy(true);
    try {
      let key = null;
      if (file) key = await uploadBoardImage(file);
      await createPost(Number(id), maskProfanity(content.trim()), password, key);
      setContent(''); setPassword(''); setFile(null); load();
    } catch (e2) { setErr(e2.message || '작성 실패'); }
    setBusy(false);
  }

  return (
    <div className="page noscreenshot">
      <header className="page-header row">
        <Link to="/boards" className="link-btn">← 게시판</Link><h2>{title}</h2><span style={{ width: '2.5rem' }} />
      </header>
      {!isHot && (
        <form className="memo-form" onSubmit={submit}>
          <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={2} placeholder="익명으로 글쓰기" />
          <div className="memo-form-row">
            <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} />
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="삭제용 비번" />
            <button className="btn-add" disabled={busy}>{busy ? '…' : '등록'}</button>
          </div>
          {err && <p className="error-msg">{err}</p>}
        </form>
      )}
      <ul className="post-list">
        {posts.length === 0 && <p className="muted center">아직 글이 없습니다.</p>}
        {posts.map((p) => (
          <li key={p.id} className="post-item">
            <Link to={`/board/post/${p.id}`}>
              <p className="post-content">{p.content}</p>
              {p.image_key && <BoardImage imageKey={p.image_key} className="post-thumb" />}
              <div className="post-meta">👍 {p.like_count} · 👎 {p.dislike_count} · 💬 {p.comment_count} · 🚨 {p.report_count}{p.hot ? ' · 🔥' : ''}</div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
