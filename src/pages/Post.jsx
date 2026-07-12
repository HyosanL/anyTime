import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuthContext } from '../contexts/AuthContext';
import { getPost, listComments, react, addComment, deletePost, deleteComment, postImageKeys, createShare } from '../lib/board';
import { shareLink, appUrl } from '../lib/share';
import { getReacted, markReacted, unmarkReacted } from '../lib/reactions';
import { hasViewed, markViewed } from '../lib/views';
import { pushSupported, pushEnabled, enablePush, watchPost, unwatchPost, isWatched } from '../lib/push';
import { maskProfanity } from '../lib/moderation';
import { kvGet, kvSet, kvDel } from '../lib/cache';
import BoardImage from '../components/BoardImage';
import PullToRefresh from '../components/PullToRefresh';
import BackButton from '../components/BackButton';

// 상대시간: 방금 전 / N분 전 / N시간 전 / N일 전, 그 이상은 날짜
function timeAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Math.floor((Date.now() - t) / 1000);
  if (diff < 60) return '방금 전';
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}일 전`;
  const d = new Date(t);
  return `${d.getMonth() + 1}.${d.getDate()}`;
}

function CommentDelete({ id, hasPw, isAdmin, onDone }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState('');
  // 비번 없는 댓글 또는 관리자: 확인 후 바로 삭제
  if (!hasPw || isAdmin) {
    return <button className="rev-del-btn" onClick={async () => {
      if (!confirm('이 댓글을 삭제할까요?')) return;
      const { data, error } = await deleteComment(id, '');
      if (error || data === false) { alert('삭제에 실패했습니다.'); return; }
      onDone();
    }}>삭제</button>;
  }
  if (!open) return <button className="rev-del-btn" onClick={() => setOpen(true)}>삭제</button>;
  return (
    <span className="comment-del">
      <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="비번" />
      <button className="link-btn" onClick={async () => { const { data, error } = await deleteComment(id, pw); if (error || data === false) { alert('비번 불일치'); return; } onDone(); }}>확인</button>
    </span>
  );
}

export default function Post() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { cadet } = useAuthContext();
  const isAdmin = !!cadet?.is_admin;
  const [post, setPost] = useState(null);
  const [comments, setComments] = useState([]);
  const [gone, setGone] = useState(false); // 서버 기준으로 삭제/없는 글
  const [reacted, setReacted] = useState({}); // 이 기기에서 이미 누른 반응 { like, dislike, report }
  const [cText, setCText] = useState('');
  const [cPw, setCPw] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [delPw, setDelPw] = useState('');
  const [showDel, setShowDel] = useState(false);
  const [watching, setWatching] = useState(false); // 이 기기가 이 글의 댓글 알림을 받는 중
  const seq = useRef(0);

  // 루트 댓글 + parent별 답글 맵을 한 번에 만든다(댓글마다 전체 배열을 재필터하던 O(n²) 제거).
  const { roots, repliesByParent } = useMemo(() => {
    const byParent = new Map();
    const rootList = [];
    for (const c of comments) {
      if (c.parent_id) {
        const arr = byParent.get(c.parent_id);
        if (arr) arr.push(c); else byParent.set(c.parent_id, [c]);
      } else rootList.push(c);
    }
    return { roots: rootList, repliesByParent: byParent };
  }, [comments]);

  // 캐시 즉시 표시(SWR) → 서버 응답으로 교체. 서버에서 사라진 글이면 캐시 파기.
  async function load() {
    const my = ++seq.current;
    let gotFresh = false;
    kvGet(`bb:post:${id}`).then((c) => {
      if (seq.current === my && !gotFresh && c?.post) { setPost(c.post); setComments(c.comments ?? []); }
    });
    try {
      // 조회수는 기기당 1회만 집계(좋아요와 동일 — 새로고침·반응/댓글 후 재조회로 부풀지 않게)
      const viewKey = `p:${id}`;
      const countView = !hasViewed(viewKey);
      const [p, cs] = await Promise.all([getPost(id, countView), listComments(id)]);
      if (p && countView) markViewed(viewKey);
      if (seq.current !== my) return;
      gotFresh = true;
      if (!p) { setGone(true); setPost(null); kvDel(`bb:post:${id}`); return; }
      setPost(p); setComments(cs);
      kvSet(`bb:post:${id}`, { post: p, comments: cs });
    } catch { /* 오프라인 등: 캐시 유지 */ }
  }
  useEffect(() => { setGone(false); setReacted(getReacted('post', id)); setWatching(isWatched(id)); load(); /* eslint-disable-next-line */ }, [id]);

  // 🔔 댓글 알림 토글. 푸시 미지원(사파리 탭 등)이면 설치 안내로 대신한다.
  async function toggleWatch() {
    if (watching) {
      setWatching(false);
      await unwatchPost(id).catch(() => {});
      return;
    }
    if (!pushSupported()) {
      alert('이 브라우저에서는 알림을 받을 수 없어요.\n애타를 홈 화면에 설치하면(아이폰: 공유 → 홈 화면에 추가) 댓글 푸시 알림을 받을 수 있습니다.');
      return;
    }
    if (!pushEnabled()) {
      const r = await enablePush();
      if (r === 'DENIED') { alert('알림 권한이 꺼져 있어요. 기기 설정에서 애타의 알림을 허용해주세요.'); return; }
      if (r !== 'ON') { alert('알림 설정에 실패했습니다. 잠시 후 다시 시도해주세요.'); return; }
    }
    try { await watchPost(id); setWatching(true); } catch { alert('알림 설정에 실패했습니다.'); }
  }

  // 좋아요/싫어요는 재클릭 시 취소(토글), 신고는 1회 후 취소 불가.
  async function doReact(kind) {
    const on = !!reacted[kind];
    if (kind === 'report' && on) return;
    // 요청 전에 먼저 로컬 기록/해제해 연타 차단
    if (on) unmarkReacted('post', id, kind); else markReacted('post', id, kind);
    setReacted(getReacted('post', id));
    const r = await react(Number(id), on ? `un${kind}` : kind);
    if (r === 'DELETED') { alert('신고 누적으로 삭제되었습니다.'); kvDel(`bb:post:${id}`); navigate(-1); return; }
    load();
  }
  async function submitComment(e) {
    e.preventDefault();
    if (!cText.trim()) return;
    await addComment(Number(id), replyTo, maskProfanity(cText.trim()), cPw);
    setCText(''); setCPw(''); setReplyTo(null); load();
    // 푸시를 쓰는 기기면 댓글 단 글을 조용히 지켜보기(대댓글 알림)
    if (pushEnabled() && !isWatched(id)) {
      watchPost(id, 'comment').then(() => setWatching(true)).catch(() => {});
    }
  }
  // 🔗 공유: 글당 고정 토큰(/s/{token})을 발급받아 OS 공유 시트(폴백: 클립보드)로.
  // 링크는 비회원도 읽기 전용으로 열람 가능(관리자 토글로 차단 가능), 글 삭제 시 무효.
  // 메시지에는 맥락 문구를 함께 실어 받는 쪽에서 "이게 뭐야"가 되지 않게 한다.
  async function sharePost() {
    try {
      const t = await createShare(Number(id));
      if (!t) throw new Error('NO_TOKEN');
      const short = post.title && post.title.length > 24 ? `${post.title.slice(0, 24)}…` : post.title;
      // 어느 게시판의 어느 글인지 함께 실어 준다 — "애타 익명게시판 [우주공학과]의 "이찬" 글이에요."
      const where = post.board?.name ? `익명게시판 [${post.board.name}]` : '익명게시판';
      await shareLink({
        title: '애타 - AnyTime',
        text: short ? `애타 ${where}의 "${short}" 글이에요.` : `애타 ${where}에서 공유된 글이에요.`,
        url: appUrl(`/s/${t}`),
      });
    } catch { alert('공유 링크를 만들지 못했습니다. 잠시 후 다시 시도해주세요.'); }
  }
  // 삭제 클릭: 비번 있는 글은 입력창을, 없는 글·관리자는 확인 후 바로 삭제
  async function onDeleteClick() {
    if (post.post_password_hash && !isAdmin) { setShowDel((v) => !v); return; }
    if (!confirm('이 게시글을 삭제할까요?')) return;
    const { data, error } = await deletePost(Number(id), '');
    if (error || data === false) { alert('삭제에 실패했습니다.'); return; }
    kvDel(`bb:post:${id}`);
    navigate(-1);
  }
  async function doDelete() {
    const { data, error } = await deletePost(Number(id), delPw);
    if (error || data === false) { alert('비밀번호가 일치하지 않습니다.'); return; }
    kvDel(`bb:post:${id}`);
    navigate(-1);
  }

  if (gone) {
    return (
      <div className="page noscreenshot">
        <header className="page-header"><BackButton fallback="/boards" /><h2>게시글</h2></header>
        <div className="empty">
          <span className="empty-emoji">🗑️</span>
          <span>삭제되었거나 존재하지 않는 게시글입니다.</span>
        </div>
      </div>
    );
  }
  if (!post) return <div className="page-center">불러오는 중…</div>;
  const ago = timeAgo(post.created_at);

  return (
    <PullToRefresh className="page noscreenshot" onRefresh={load}>
      <header className="page-header">
        <BackButton fallback="/boards" />
        <h2>게시글</h2>
      </header>

      <article className="post-detail">
        {post.title && <h3 className="post-title-detail">{post.title}</h3>}
        <div className="post-detail-meta">
          {post.board?.name && (
            <button
              type="button"
              className="post-board-chip"
              onClick={() => navigate(`/board/${post.board_id}`)}
              title={`${post.board.name} 게시판으로 이동`}
            >{post.board.name}</button>
          )}
          {post.hot && <span className="post-flag post-flag-hot">🔥 HOT</span>}
          {ago && <span>{ago}</span>}
          <span className="metric">👀 {post.view_count ?? 0}</span>
          <span className="metric">💬 {comments.length}</span>
        </div>
        <p className="post-content">{post.content}</p>
        {postImageKeys(post).map((k) => <BoardImage key={k} imageKey={k} className="post-image" />)}
        <div className="post-react">
          <button className={`react-pill${reacted.like ? ' is-on' : ''}`} onClick={() => doReact('like')}>👍 <b>{post.like_count}</b></button>
          <button className={`react-pill${reacted.dislike ? ' is-on' : ''}`} onClick={() => doReact('dislike')}>👎 <b>{post.dislike_count}</b></button>
          <button className={`react-pill react-report${reacted.report ? ' is-on' : ''}`} disabled={!!reacted.report} onClick={() => doReact('report')}>🚨 <b>{post.report_count}</b></button>
          <button className={`react-pill${watching ? ' is-on' : ''}`} onClick={toggleWatch} title="이 글에 댓글이 달리면 푸시 알림">
            {watching ? '🔔' : '🔕'} 알림
          </button>
          <button className="react-pill" onClick={sharePost} title="이 글의 링크 공유">🔗 공유</button>
          <button className="rev-del-btn post-del-toggle" onClick={onDeleteClick}>삭제</button>
        </div>
        {showDel && (
          <div className="post-del-row">
            <input type="password" value={delPw} onChange={(e) => setDelPw(e.target.value)} placeholder="게시글 비번" />
            <button className="btn-danger-soft btn-sm" onClick={doDelete}>삭제 확인</button>
          </div>
        )}
      </article>

      <form className="comment-form" onSubmit={submitComment}>
        {replyTo && (
          <span className="comment-reply-hint">↳ 답글 작성 중 <button type="button" className="link-btn" onClick={() => setReplyTo(null)}>취소</button></span>
        )}
        <textarea value={cText} onChange={(e) => setCText(e.target.value)} rows={2} placeholder={replyTo ? '답글을 입력하세요' : '댓글을 입력하세요'} />
        <div className="comment-form-row">
          <input type="password" value={cPw} onChange={(e) => setCPw(e.target.value)} placeholder="삭제용 비번 (선택)" />
          <button className="btn-add">등록</button>
        </div>
      </form>

      <h3 className="section-label">댓글 {comments.length}</h3>
      <ul className="comment-list">
        {roots.length === 0 && (
          <li className="empty">
            <span className="empty-emoji">💬</span>
            <span>첫 댓글을 남겨보세요.</span>
          </li>
        )}
        {roots.map((c) => (
          <li key={c.id} className="comment">
            <p className="comment-body">{c.content}</p>
            <div className="comment-actions">
              <button className="link-btn" onClick={() => setReplyTo(c.id)}>답글</button>
              <CommentDelete id={c.id} hasPw={!!c.post_password_hash} isAdmin={isAdmin} onDone={load} />
            </div>
            {(repliesByParent.get(c.id) || []).map((rc) => (
              <div key={rc.id} className="reply">
                <p className="comment-body"><span className="reply-arrow">↳</span> {rc.content}</p>
                <div className="comment-actions"><CommentDelete id={rc.id} hasPw={!!rc.post_password_hash} isAdmin={isAdmin} onDone={load} /></div>
              </div>
            ))}
          </li>
        ))}
      </ul>
    </PullToRefresh>
  );
}
