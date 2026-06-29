import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getPost, listComments, react, addComment, deletePost, deleteComment } from '../lib/board';
import { maskProfanity } from '../lib/moderation';
import BoardImage from '../components/BoardImage';

function CommentDelete({ id, onDone }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState('');
  if (!open) return <button className="link-btn" onClick={() => setOpen(true)}>삭제</button>;
  return (
    <span>
      <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="비번" style={{ width: '5rem' }} />
      <button className="link-btn" onClick={async () => { const { data, error } = await deleteComment(id, pw); if (error || data === false) { alert('비번 불일치'); return; } onDone(); }}>확인</button>
    </span>
  );
}

export default function Post() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [post, setPost] = useState(null);
  const [comments, setComments] = useState([]);
  const [cText, setCText] = useState('');
  const [cPw, setCPw] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [delPw, setDelPw] = useState('');
  const [showDel, setShowDel] = useState(false);

  async function load() { setPost(await getPost(id)); setComments(await listComments(id)); }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  async function doReact(kind) {
    const r = await react(Number(id), kind);
    if (r === 'DELETED') { alert('신고 누적으로 삭제되었습니다.'); navigate(-1); return; }
    load();
  }
  async function submitComment(e) {
    e.preventDefault();
    if (!cText.trim() || cPw.length < 2) return;
    await addComment(Number(id), replyTo, maskProfanity(cText.trim()), cPw);
    setCText(''); setCPw(''); setReplyTo(null); load();
  }
  async function doDelete() {
    const { data, error } = await deletePost(Number(id), delPw);
    if (error || data === false) { alert('비밀번호가 일치하지 않습니다.'); return; }
    navigate(-1);
  }

  if (!post) return <div className="page-center">불러오는 중…</div>;
  const roots = comments.filter((c) => !c.parent_id);
  const repliesOf = (pid) => comments.filter((c) => c.parent_id === pid);

  return (
    <div className="page noscreenshot">
      <header className="page-header row"><button className="link-btn" onClick={() => navigate(-1)}>← 뒤로</button><h2>게시글</h2><span style={{ width: '2.5rem' }} /></header>
      <div className="post-detail">
        <p className="post-content">{post.content}</p>
        {post.image_key && <BoardImage imageKey={post.image_key} className="post-image" />}
        <div className="post-react">
          <button onClick={() => doReact('like')}>👍 {post.like_count}</button>
          <button onClick={() => doReact('dislike')}>👎 {post.dislike_count}</button>
          <button className="report" onClick={() => doReact('report')}>🚨 {post.report_count}</button>
          <button className="rev-del-btn" onClick={() => setShowDel((v) => !v)}>삭제</button>
        </div>
        {showDel && <div className="memo-form-row"><input type="password" value={delPw} onChange={(e) => setDelPw(e.target.value)} placeholder="게시글 비번" /><button className="btn-remove" onClick={doDelete}>확인</button></div>}
      </div>

      <form className="memo-form" onSubmit={submitComment}>
        {replyTo && <span className="muted">↳ 답글 작성 중 <button type="button" className="link-btn" onClick={() => setReplyTo(null)}>취소</button></span>}
        <textarea value={cText} onChange={(e) => setCText(e.target.value)} rows={2} placeholder={replyTo ? '답글' : '댓글'} />
        <div className="memo-form-row"><input type="password" value={cPw} onChange={(e) => setCPw(e.target.value)} placeholder="삭제용 비번" /><button className="btn-add">등록</button></div>
      </form>

      <ul className="comment-list">
        {roots.length === 0 && <p className="muted center">첫 댓글을 남겨보세요.</p>}
        {roots.map((c) => (
          <li key={c.id} className="comment">
            <p>{c.content}</p>
            <div className="comment-actions"><button className="link-btn" onClick={() => setReplyTo(c.id)}>답글</button><CommentDelete id={c.id} onDone={load} /></div>
            {repliesOf(c.id).map((rc) => (
              <div key={rc.id} className="reply"><p>↳ {rc.content}</p><CommentDelete id={rc.id} onDone={load} /></div>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
