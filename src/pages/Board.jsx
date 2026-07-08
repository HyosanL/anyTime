import { useEffect, useRef, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { getBoard, listPosts, listHot, createPost, uploadBoardImages, postImageKeys, PAGE_SIZE, boardEnabled } from '../lib/board';
import { maskProfanity } from '../lib/moderation';
import { pushEnabled, watchPost } from '../lib/push';
import { kvGet, kvSet } from '../lib/cache';
import PullToRefresh from '../components/PullToRefresh';
import BackButton from '../components/BackButton';

const MAX_IMAGES = 10;

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

export default function Board() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isHot = id === 'hot';
  const [title, setTitle] = useState(isHot ? '🔥 HOT' : '게시판');
  const [posts, setPosts] = useState(null); // null = 아직 캐시/서버 어느 쪽도 안 옴
  const [page, setPage] = useState(0);
  const seq = useRef(0); // 게시판/페이지 전환 시 늦게 온 응답이 덮어쓰지 않도록
  const [writing, setWriting] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [pTitle, setPTitle] = useState('');
  const [content, setContent] = useState('');
  const [password, setPassword] = useState('');
  const [files, setFiles] = useState([]); // File[]
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  function pickFiles(list) {
    const picked = Array.from(list || []);
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      const merged = [...prev];
      for (const f of picked) {
        const k = `${f.name}:${f.size}`;
        if (!seen.has(k)) { seen.add(k); merged.push(f); }
      }
      return merged.slice(0, MAX_IMAGES);
    });
  }
  const removeFile = (i) => setFiles((prev) => prev.filter((_, idx) => idx !== i));

  // 캐시 즉시 표시(SWR) → 서버 응답으로 교체·캐시 갱신. 오프라인이면 캐시 유지.
  async function load(p) {
    const my = ++seq.current;
    let gotFresh = false;
    const postsKey = isHot ? `bb:hot:${p}` : `bb:posts:${id}:${p}`;
    kvGet(postsKey).then((c) => { if (seq.current === my && !gotFresh && c) setPosts(c); });
    if (!isHot) kvGet(`bb:board:${id}`).then((b) => { if (seq.current === my && !gotFresh && b) setTitle(b.name || '게시판'); });
    try {
      if (isHot) {
        const rows = await listHot(p);
        if (seq.current !== my) return;
        gotFresh = true; setTitle('🔥 HOT'); setPosts(rows);
        kvSet(postsKey, rows);
      } else {
        const [b, rows] = await Promise.all([getBoard(id), listPosts(id, p)]);
        if (seq.current !== my) return;
        gotFresh = true; setTitle(b?.name || '게시판'); setPosts(rows);
        kvSet(postsKey, rows); if (b) kvSet(`bb:board:${id}`, b);
      }
    } catch { /* 오프라인 등: 캐시 유지 */ }
  }
  // id 가 바뀌면 렌더 중에 page 를 0 으로 되돌린다(React 권장 derived-state 패턴).
  // 예전엔 [id] 이펙트와 [page] 이펙트가 각각 load(0) 을 호출해 게시판 진입/이동마다
  // 같은 목록을 2번 요청했다 — 단일 [id,page] 이펙트로 통합해 중복 제거.
  const [prevId, setPrevId] = useState(id);
  if (id !== prevId) { setPrevId(id); setPage(0); }
  useEffect(() => { boardEnabled().then(setEnabled); }, []); // 전역 플래그 — 게시판 이동마다 재요청 불필요
  useEffect(() => { load(page); /* eslint-disable-next-line */ }, [id, page]);

  async function submit(e) {
    e.preventDefault(); setErr('');
    if (!pTitle.trim()) return setErr('제목을 입력하세요.');
    if (!content.trim()) return setErr('내용을 입력하세요.');
    setBusy(true);
    try {
      let keys = [];
      if (files.length) keys = await uploadBoardImages(files);
      const newId = await createPost(Number(id), maskProfanity(pTitle.trim()), maskProfanity(content.trim()), password, keys);
      // 푸시를 쓰는 기기면 내가 쓴 글을 조용히 지켜보기(댓글 알림).
      // 서버는 "watch 한 기기"만 알 뿐 작성자는 저장하지 않는다.
      if (newId && pushEnabled()) watchPost(newId, 'post').catch(() => {});
      setPTitle(''); setContent(''); setPassword(''); setFiles([]); setWriting(false);
      if (page === 0) load(0); else setPage(0);
    } catch (e2) { setErr(e2.message || '작성 실패'); }
    setBusy(false);
  }

  const preview = (s) => { const t = (s || '').replace(/\s+/g, ' ').trim(); return t.length > 60 ? t.slice(0, 60) + '…' : t; };

  return (
    <PullToRefresh className="page noscreenshot" onRefresh={() => load(page)}>
      <header className="page-header">
        <BackButton fallback="/boards" />
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
            <span className="board-file-label">📷 이미지 첨부{files.length ? ` · ${files.length}장` : ` (최대 ${MAX_IMAGES}장)`}</span>
            <input
              type="file" accept="image/*" multiple
              onChange={(e) => { pickFiles(e.target.files); e.target.value = ''; }}
            />
          </label>
          {files.length > 0 && (
            <ul className="board-file-chips">
              {files.map((f, i) => (
                <li key={`${f.name}:${f.size}:${i}`} className="board-file-chip">
                  <span className="board-file-chip-name">{f.name}</span>
                  <button type="button" className="board-file-chip-x" aria-label="제거" onClick={() => removeFile(i)}>×</button>
                </li>
              ))}
            </ul>
          )}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="삭제용 비밀번호 (선택 · 비우면 누구나 삭제)" />
          {err && <p className="error-msg">{err}</p>}
          <button className="btn-add btn-block" disabled={busy}>{busy ? '등록 중…' : '글 등록'}</button>
        </form>
      )}

      {enabled && (
        <>
          <ul className="post-list">
            {posts !== null && posts.length === 0 && (
              <li className="empty">
                <span className="empty-emoji">📝</span>
                <span>아직 글이 없습니다.{!isHot ? ' 첫 글을 남겨보세요.' : ''}</span>
              </li>
            )}
            {(posts ?? []).map((p) => {
              const snippet = preview(p.content);
              const ago = timeAgo(p.created_at);
              return (
                <li key={p.id}>
                  <Link to={`/board/post/${p.id}`} className="post-item">
                    <span className="post-line">
                      {/* HOT 목록은 여러 게시판이 섞이므로 원 게시판을 앞에 병기한다.
                          칩을 누르면 글 대신 그 게시판으로 이동(바깥 Link 기본동작 차단). */}
                      {isHot && p.board?.name && (
                        <button
                          type="button"
                          className="post-board-chip"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate(`/board/${p.board_id}`); }}
                          title={`${p.board.name} 게시판으로 이동`}
                        >{p.board.name}</button>
                      )}
                      <span className="post-item-title">{p.title || '(제목 없음)'}</span>
                      {p.hot && <span className="post-flag post-flag-hot">🔥</span>}
                      {postImageKeys(p).length > 0 && <span className="post-flag">🖼</span>}
                    </span>
                    {snippet && <span className="post-item-preview">{snippet}</span>}
                    <span className="post-item-meta">
                      {ago && <span className="post-meta-time">{ago}</span>}
                      <span className="metric">👀 {p.view_count ?? 0}</span>
                      <span className="metric">💬 {p.comment_count}</span>
                      <span className="metric">👍 {p.like_count}</span>
                      {p.dislike_count > 0 && <span className="metric">👎 {p.dislike_count}</span>}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>

          <div className="pager">
            <button className="btn-ghost btn-sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← 최신</button>
            <span className="pager-now">{page + 1}페이지</span>
            <button className="btn-ghost btn-sm" disabled={(posts?.length ?? 0) < PAGE_SIZE} onClick={() => setPage((p) => p + 1)}>이전 글 →</button>
          </div>
        </>
      )}
    </PullToRefresh>
  );
}
