import { useEffect, useRef, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { getBoard, listPosts, listHot, createPost, uploadBoardImages, postImageKeys, PAGE_SIZE } from '../lib/board';
import { maskText, prefetchMask } from '../lib/mask';
import { pushEnabled, watchPost } from '../lib/push';
import { kvGet, kvSet } from '../lib/cache';
import { useAuthContext } from '../contexts/AuthContext';
import PullToRefresh from '../components/PullToRefresh';
import BackButton from '../components/BackButton';
import '../styles/board.css';
import '../styles/course.css';

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
  const [loadingMore, setLoadingMore] = useState(false); // 첫/추가 로딩 진행 중
  const [hasMore, setHasMore] = useState(true);          // 더 불러올 과거 글이 있는지
  const seq = useRef(0);            // 게시판 전환 시 늦게 온 응답이 덮어쓰지 않도록
  const pageRef = useRef(0);        // 마지막으로 로드한 페이지
  const loadingRef = useRef(false); // 동시 로드 방지(옵서버 연타 차단)
  const hasMoreRef = useRef(true);  // 옵서버 클로저에서 최신값 참조
  const sentinelRef = useRef(null); // 하단 감지용 센티넬
  const [writing, setWriting] = useState(false);
  // 게시판 활성 여부는 부팅 RPC 로 이미 와 있다(마운트마다 board_enabled() 를 부르지 않는다).
  const { settings } = useAuthContext();
  const enabled = settings.boardEnabled;
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

  const fetchPage = (p) => (isHot ? listHot(p) : listPosts(id, p));

  // 첫 페이지: 캐시 즉시 표시(SWR) → 서버 응답으로 교체. 게시판 진입·새로고침 시.
  async function loadFirst() {
    const my = ++seq.current;
    loadingRef.current = true; setLoadingMore(true);
    let gotFresh = false;
    const key0 = isHot ? 'bb:hot:0' : `bb:posts:${id}:0`;
    kvGet(key0).then((c) => { if (seq.current === my && !gotFresh && c) setPosts(c); });
    if (!isHot) kvGet(`bb:board:${id}`).then((b) => { if (seq.current === my && !gotFresh && b) setTitle(b.name || '게시판'); });
    try {
      let rows;
      let b = null;
      if (isHot) rows = await listHot(0);
      else { const res = await Promise.all([getBoard(id), listPosts(id, 0)]); b = res[0]; rows = res[1]; }
      if (seq.current !== my) return;
      gotFresh = true;
      if (isHot) setTitle('🔥 HOT');
      else { setTitle(b?.name || '게시판'); if (b) kvSet(`bb:board:${id}`, b); }
      setPosts(rows);
      pageRef.current = 0;
      const more = rows.length >= PAGE_SIZE;
      hasMoreRef.current = more; setHasMore(more);
      kvSet(key0, rows);
    } catch { /* 오프라인 등: 캐시 유지 */ }
    finally { if (seq.current === my) { loadingRef.current = false; setLoadingMore(false); } }
  }

  // 다음 페이지: 스크롤이 하단에 닿으면 과거 글을 PAGE_SIZE개씩 이어붙인다.
  async function loadMore() {
    if (loadingRef.current || !hasMoreRef.current) return;
    const my = seq.current; // 같은 게시판인지 확인용(증가시키지 않음)
    loadingRef.current = true; setLoadingMore(true);
    const next = pageRef.current + 1;
    try {
      const rows = await fetchPage(next);
      if (seq.current !== my) return; // 그새 게시판이 바뀜 → 버림
      pageRef.current = next;
      setPosts((prev) => [...(prev ?? []), ...rows]);
      const more = rows.length >= PAGE_SIZE;
      hasMoreRef.current = more; setHasMore(more);
    } catch { /* 네트워크 실패: 로딩만 풀고 다음 스크롤에서 재시도 */ }
    finally { if (seq.current === my) { loadingRef.current = false; setLoadingMore(false); } }
  }

  // 게시판 진입/변경: 상태 초기화 후 첫 페이지부터.
  useEffect(() => {
    setPosts(null); pageRef.current = 0; hasMoreRef.current = true; setHasMore(true);
    loadFirst();
    // eslint-disable-next-line
  }, [id]);

  // 하단 센티넬이 뷰포트(600px 이내)에 들어오면 다음 페이지 로드. posts 가 늘 때마다 재관찰해
  // 화면이 길어 센티넬이 계속 보이는 경우에도 이어서 채운다(hasMore=false 면 센티넬이 사라져 자연 종료).
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) loadMore();
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line
  }, [posts, hasMore, id]);

  async function submit(e) {
    e.preventDefault(); setErr('');
    if (!pTitle.trim()) return setErr('제목을 입력하세요.');
    if (!content.trim()) return setErr('내용을 입력하세요.');
    setBusy(true);
    try {
      let keys = [];
      if (files.length) keys = await uploadBoardImages(files);
      const [title, body] = await Promise.all([maskText(pTitle.trim()), maskText(content.trim())]);
      const newId = await createPost(id, title, body, password, keys);
      // 푸시를 쓰는 기기면 내가 쓴 글을 조용히 지켜보기(댓글 알림).
      // 서버는 "watch 한 기기"만 알 뿐 작성자는 저장하지 않는다.
      if (newId && pushEnabled()) watchPost(newId, 'post').catch(() => {});
      setPTitle(''); setContent(''); setPassword(''); setFiles([]); setWriting(false);
      loadFirst(); // 새 글이 맨 위에 보이도록 첫 페이지부터 다시
    } catch (e2) { setErr(e2.message || '작성 실패'); }
    setBusy(false);
  }

  const preview = (s) => { const t = (s || '').replace(/\s+/g, ' ').trim(); return t.length > 60 ? t.slice(0, 60) + '…' : t; };

  return (
    <PullToRefresh className="page noscreenshot" onRefresh={loadFirst}>
      <header className="page-header">
        <BackButton fallback="/boards" />
        <h2>{title}</h2>
        {/* 글쓰기를 열면 그때 비속어 사전을 미리 받는다 — 읽기만 하는 사람은 받지 않는다. */}
        {!isHot && enabled && <button className="link-btn" onClick={() => { setWriting((v) => !v); prefetchMask(); }}>{writing ? '닫기' : '글쓰기'}</button>}
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
              const ago = timeAgo(p.createdAt);
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
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate(`/board/${p.boardId}`); }}
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
                      <span className="metric">👀 {p.viewCount ?? 0}</span>
                      <span className="metric">💬 {p.commentCount}</span>
                      <span className="metric">👍 {p.likeCount}</span>
                      {p.dislikeCount > 0 && <span className="metric">👎 {p.dislikeCount}</span>}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>

          {/* 무한 스크롤: 하단 센티넬이 보이면 과거 글을 PAGE_SIZE개씩 이어 로딩(에타식). */}
          {posts === null && <p className="muted center">불러오는 중…</p>}
          {hasMore && posts && posts.length > 0 && <div ref={sentinelRef} style={{ height: 1 }} aria-hidden="true" />}
          {loadingMore && posts && posts.length > 0 && <p className="muted center board-more-loading">불러오는 중…</p>}
          {!hasMore && posts && posts.length > 0 && <p className="muted center board-more-end">모든 글을 불러왔어요</p>}
        </>
      )}
    </PullToRefresh>
  );
}
