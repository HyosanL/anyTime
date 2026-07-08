import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuthContext } from '../contexts/AuthContext';
import { getSharedPost, boardImageObjectUrl, shareImageObjectUrl } from '../lib/board';
import { stashPendingNav } from '../lib/push';
import { appUrl } from '../lib/share';
import { isIos, isMobile, isStandalone } from '../components/InstallGate';
import BoardImage from '../components/BoardImage';

// 상대시간: 방금 전 / N분 전 / N시간 전 / N일 전, 그 이상은 날짜 (Post.jsx 와 동일한 파일 로컬 유틸)
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

// =====================================================================
//  공유 링크 화면 (/s/:token) — 로그인 없이 딱 이 글 하나만 읽기 전용으로.
//  - 회원(세션 有): 데스크톱·설치 앱이면 앱 내 글 화면으로 즉시 이동.
//    모바일 브라우저면 pending-nav 에 목적지를 남기고(앱을 열면 그 글로 이동,
//    push 딥링크와 같은 통로·3분 유효) 이 화면으로 읽게 한다 — 웹에서 설치된
//    WebAPK 를 직접 실행하는 API 는 없다(2026-07-05 실측, InstallGate 참고).
//  - 비회원: 읽기 전용 + 시작하기 CTA. 관리자가 비회원 열람을 차단하면 안내만.
//  - 조회수: 비회원 열람도 집계(p_view, 기기 세션당 1회). 회원은 앱 화면(get_post_b)
//    쪽에서 집계되므로 여기선 세지 않는다(중복 방지 — 서버도 anon 만 +1).
// =====================================================================
export default function SharePost() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { session, loading } = useAuthContext();
  const [state, setState] = useState('loading'); // loading | gone | disabled | view
  const [data, setData] = useState(null);
  const [banner, setBanner] = useState(false); // 회원 + 모바일 브라우저: "앱에서 이어보기" 안내
  const [copied, setCopied] = useState(false); // iOS 핸드오프: 글 주소 복사 완료

  useEffect(() => {
    if (loading) return undefined;
    let active = true;
    (async () => {
      let countView = false;
      if (!session) {
        try { countView = !sessionStorage.getItem(`bb:viewed:s:${token}`); } catch { /* 프라이버시 모드 등 */ }
      }
      const { data: d, error } = await getSharedPost(token, countView);
      if (!active) return;
      if (error || !d) { setState('gone'); return; }
      if (d.disabled) { setState('disabled'); return; }
      if (countView) { try { sessionStorage.setItem(`bb:viewed:s:${token}`, '1'); } catch { /* noop */ } }
      const appPath = `/board/post/${d.post_id}`;
      if (session) {
        if (!isMobile() || isStandalone()) { navigate(appPath, { replace: true }); return; }
        stashPendingNav(appPath);
        setBanner(true);
      }
      setData(d);
      setState('view');
    })();
    return () => { active = false; };
  }, [token, loading, session, navigate]);

  // 비회원은 공유 토큰으로, (모바일 브라우저의) 회원은 기존 인증 경로로 이미지 로드
  // — 비회원 열람이 차단돼도 회원에겐 이미지가 계속 보이게 하기 위함.
  const imgLoader = session ? boardImageObjectUrl : (k, o) => shareImageObjectUrl(token, k, o);

  // iOS 핸드오프: 사파리↔홈화면앱 저장소 분리 + 앱 실행 API 부재라 자동 전달(pending-nav)이
  // 불가능한 유일한 플랫폼. 글 주소를 복사해 두면 앱 홈의 [붙여넣어 열기]가 이동시켜 준다.
  const iosBrowser = isIos() && !isStandalone();
  async function copyForApp() {
    const link = appUrl(`/board/post/${data.post_id}`);
    try { await navigator.clipboard.writeText(link); } catch { prompt('아래 주소를 복사해 애타 앱의 [붙여넣어 열기]에 붙여넣으세요', link); }
    setCopied(true);
  }

  const head = (
    <header className="share-topbar">
      <img src="/icons/icon.svg" className="share-logo" alt="" />
      <b>애타</b>
      <span className="share-topbar-sub">공군사관학교 생도 커뮤니티</span>
      <Link to="/login" className="btn-add btn-sm share-start">시작하기</Link>
    </header>
  );

  if (state === 'loading') return <div className="page-center">불러오는 중…</div>;
  if (state === 'gone' || state === 'disabled') {
    return (
      <div className="page share-page">
        {head}
        <div className="empty share-empty">
          <span className="empty-emoji">{state === 'gone' ? '🗑️' : '🔒'}</span>
          <span>
            {state === 'gone'
              ? '삭제되었거나 존재하지 않는 게시글입니다.'
              : '비회원 열람이 제한된 글입니다. 애타 앱에서 로그인 후 확인해주세요.'}
          </span>
        </div>
      </div>
    );
  }

  const { post, comments = [], images = [] } = data;
  const keys = [...images].sort((a, b) => (a.seq || 0) - (b.seq || 0)).map((i) => i.object_key);
  const roots = comments.filter((c) => !c.parent_id);
  const repliesOf = (pid) => comments.filter((c) => c.parent_id === pid);
  const ago = timeAgo(post.created_at);

  return (
    <div className="page share-page noscreenshot">
      {head}
      {banner && (
        <p className="share-banner">
          📲 홈 화면의 <b>애타</b> 앱을 열면 이 글이 바로 열려요.
          (Chrome 메뉴 <b>⋮</b> → <b>앱에서 열기</b>)
        </p>
      )}
      {iosBrowser && (
        <p className="share-banner">
          {copied ? (
            <>✅ 복사했어요! <b>애타</b> 앱을 열고 홈 화면의 <b>📋 붙여넣어 열기</b>를 누르면 이 글로 이동해요.</>
          ) : (
            <>📲 애타 앱이 있다면 <button type="button" className="link-btn share-copy-btn" onClick={copyForApp}>앱에서 이어보기</button> — 글 주소를 복사해 앱에서 바로 열 수 있어요.</>
          )}
        </p>
      )}

      <article className="post-detail">
        {post.title && <h3 className="post-title-detail">{post.title}</h3>}
        <div className="post-detail-meta">
          {post.hot && <span className="post-flag post-flag-hot">🔥 HOT</span>}
          {ago && <span>{ago}</span>}
          <span className="metric">👀 {post.view_count ?? 0}</span>
          <span className="metric">💬 {comments.length}</span>
        </div>
        <p className="post-content">{post.content}</p>
        {keys.map((k) => <BoardImage key={k} imageKey={k} className="post-image" loader={imgLoader} />)}
        <div className="post-detail-meta share-react-static">
          <span className="metric">👍 {post.like_count}</span>
          <span className="metric">👎 {post.dislike_count}</span>
        </div>
      </article>

      <h3 className="section-label">댓글 {comments.length}</h3>
      <ul className="comment-list">
        {roots.length === 0 && (
          <li className="empty">
            <span className="empty-emoji">💬</span>
            <span>아직 댓글이 없습니다.</span>
          </li>
        )}
        {roots.map((c) => (
          <li key={c.id} className="comment">
            <p className="comment-body">{c.content}</p>
            <div className="comment-actions"><span className="share-comment-time">{timeAgo(c.created_at)}</span></div>
            {repliesOf(c.id).map((rc) => (
              <div key={rc.id} className="reply">
                <p className="comment-body"><span className="reply-arrow">↳</span> {rc.content}</p>
              </div>
            ))}
          </li>
        ))}
      </ul>

      {!session && (
        <div className="share-cta">
          <p>애타에서 우리 학교 강의평·족보·익명게시판을 만나보세요.</p>
          <Link to="/login" className="btn-add btn-block">애타 시작하기</Link>
        </div>
      )}
    </div>
  );
}
