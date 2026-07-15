import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthContext } from '../contexts/AuthContext';
import { getCatalog, buildMyTimetable } from '../lib/cache';
import { buildCommonBlocks } from '../lib/commonBlock';
import { setTtPublic, searchSharedUsers, getGallery, followUser, unfollowUser, setNickname, reorderFollows } from '../lib/friends';
import TimetableGrid from '../components/TimetableGrid';
import BackButton from '../components/BackButton';
import '../styles/friends.css';

// 한 사람의 확정시간표 격자 — 캐시된 카탈로그 + 그 사람의 (분반 id·직접추가)로 그린다(읽기 전용).
function FriendGrid({ catalog, item }) {
  const { mine, periods } = useMemo(
    () => (catalog && item.timetable ? buildMyTimetable(catalog, item.entries, item.timetable) : { mine: [], periods: [] }),
    [catalog, item]
  );
  const commonBlocks = useMemo(
    () => (catalog && item.timetable ? buildCommonBlocks(catalog, item.timetable) : []),
    [catalog, item]
  );
  if (!item.public) return <p className="fr-none muted">아직 확정시간표를 공개하지 않았어요.<br />공개하면 여기 자동으로 떠요.</p>;
  if (!item.timetable) return <p className="fr-none muted">이번 학기 확정 시간표가 없어요.</p>;
  if (mine.length === 0 && (item.customs?.length ?? 0) === 0) return <p className="fr-none muted">담긴 강의가 없어요.</p>;
  return <TimetableGrid mine={mine} periods={periods} customClasses={item.customs || []} commonBlocks={commonBlocks} showProfessor={false} readOnly />;
}

// 화면: 시간표 공유(친구). 내 확정시간표 공개 토글 + 아이디 검색 + 팔로우한 사람들의 확정시간표 갤러리.
export default function Friends() {
  const { cadet } = useAuthContext();
  const uid = cadet?.id;

  const [pub, setPub] = useState(() => !!cadet?.tt_public);
  const [pubBusy, setPubBusy] = useState(false);

  const [catalog, setCatalog] = useState(null);
  const [gallery, setGallery] = useState(null);   // null = 로딩 전
  const [headTop, setHeadTop] = useState(0);       // 스택 카드가 붙을 위치(앱 헤더 아래)
  const [reorderOpen, setReorderOpen] = useState(false);

  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);    // null = 검색 안 함
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);

  useEffect(() => { getCatalog().then(setCatalog).catch(() => {}); }, []);

  // 스택 카드는 sticky 로 '앱 헤더 아래'에 붙는다 — 헤더 높이(노치 포함)를 재서 top 오프셋으로 쓴다.
  useEffect(() => {
    const measure = () => setHeadTop(document.querySelector('.page-header')?.offsetHeight || 0);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const loadGallery = useCallback(async () => {
    try { setGallery(await getGallery()); } catch { setGallery([]); }
  }, []);
  useEffect(() => { loadGallery(); }, [loadGallery]);

  // 내 프로필의 공개값이 뒤늦게 로드되면 반영
  useEffect(() => { if (cadet) setPub(!!cadet.tt_public); }, [cadet?.tt_public]);

  async function togglePublic() {
    setPubBusy(true);
    const next = !pub;
    setPub(next);                          // 낙관적
    try { setPub(!!(await setTtPublic(next))); }
    catch { setPub(!next); }               // 실패 롤백
    finally { setPubBusy(false); }
  }

  async function runSearch(e) {
    e?.preventDefault();
    const term = q.trim();
    if (!term) { setResults(null); return; }
    const my = ++seq.current;
    setSearching(true);
    try {
      const rows = await searchSharedUsers(term);
      if (my === seq.current) setResults(rows);
    } finally {
      if (my === seq.current) setSearching(false);
    }
  }

  async function follow(u) {
    const nick = prompt(`'${u.username}' 별칭 (선택, 비워도 됨)`, '');
    if (nick === null) return;             // 취소
    try {
      await followUser(uid, u.id, nick);
      setResults((rs) => rs?.map((r) => (r.id === u.id ? { ...r, following: true } : r)));
      await loadGallery();
    } catch { alert('추가에 실패했어요. 잠시 후 다시 시도해주세요.'); }
  }

  async function editNick(item) {
    const nick = prompt(`'${item.username}' 별칭`, item.nickname || '');
    if (nick === null) return;
    try { await setNickname(uid, item.followee_id, nick); await loadGallery(); }
    catch { alert('별칭 변경에 실패했어요.'); }
  }

  async function unfollow(item) {
    if (!confirm(`${item.nickname || item.username} 님을 목록에서 지울까요?`)) return;
    try { await unfollowUser(uid, item.followee_id); await loadGallery(); }
    catch { alert('삭제에 실패했어요.'); }
  }

  // 순서 편집 모드에서 드래그로 재정렬한 결과(id 순서)를 갤러리에 반영 + 서버 저장.
  async function reorderTo(ids) {
    setGallery((prev) => {
      if (!prev) return prev;
      const byId = new Map(prev.map((g) => [g.followee_id, g]));
      return ids.map((id) => byId.get(id)).filter(Boolean);
    });
    try { await reorderFollows(ids); }
    catch { loadGallery(); }
  }

  return (
    <div className="page">
      <header className="page-header">
        <BackButton />
        <h2>👥 시간표 공유</h2>
      </header>

      <div className="home-body">
        {/* 내 공개 토글 */}
        <section className="card account-sec">
          <label className="fr-toggle">
            <input type="checkbox" checked={pub} onChange={togglePublic} disabled={pubBusy} />
            <span><b>내 확정시간표 공개</b></span>
          </label>
          <p className="account-note">
            켜면 다른 생도가 <b>아이디로 나를 검색</b>해 내 <b>확정 시간표</b>를 볼 수 있어요.
            초안 시간표와 직접추가한 강의명은 공개되지만, 게시판 익명성과는 별개예요. 언제든 끌 수 있어요.
          </p>
        </section>

        {/* 아이디 검색 */}
        <section className="card">
          <p className="section-label">친구 찾기</p>
          <form className="search-bar" onSubmit={runSearch}>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="아이디 검색 후 Enter" />
          </form>
          {searching && <p className="muted center">검색 중…</p>}
          {results !== null && !searching && (
            results.length === 0 ? (
              <p className="muted center fr-empty">공개한 사용자 중 일치하는 아이디가 없어요.</p>
            ) : (
              <ul className="fr-search-list">
                {results.map((u) => (
                  <li key={u.id} className="fr-search-row">
                    <span className="fr-uname">{u.username}</span>
                    {!u.public && <span className="fr-private-tag" title="아직 공개하지 않은 사용자 — 추가해두면 나중에 공개했을 때 떠요">비공개</span>}
                    {u.following
                      ? <span className="fr-added">추가됨</span>
                      : <button className="btn-add btn-sm" onClick={() => follow(u)}>추가</button>}
                  </li>
                ))}
              </ul>
            )
          )}
        </section>

        {/* 갤러리 — 스택형: 한 화면에 친구 한 명, 아래 친구가 위 친구를 덮으며 올라온다(sticky) */}
        <section className="fr-gallery-sec">
          <div className="fr-gallery-label">
            <p className="section-label">친구 시간표</p>
            {gallery && gallery.length >= 2 && (
              <button className="link-btn" onClick={() => setReorderOpen(true)}>순서 편집</button>
            )}
          </div>
          {gallery === null ? (
            <p className="muted center">불러오는 중…</p>
          ) : gallery.length === 0 ? (
            <div className="empty fr-gallery-empty">
              <span className="empty-emoji" aria-hidden="true">🗓️</span>
              <p className="muted">아직 담은 친구가 없어요. 위에서 아이디로 검색해 추가해보세요.</p>
            </div>
          ) : (
            <div className="fr-gallery" style={{ '--fr-top': `${headTop}px` }}>
              {gallery.map((item) => (
                <div key={item.followee_id} className="fr-card">
                  <div className="fr-card-head">
                    <span className="fr-card-name">{item.nickname || item.username}</span>
                    {item.nickname && <span className="fr-card-sub">{item.username}</span>}
                    <span className="fr-card-ops">
                      <button className="link-btn" onClick={() => editNick(item)}>별칭</button>
                      <button className="link-btn tt-op-del" onClick={() => unfollow(item)}>삭제</button>
                    </span>
                  </div>
                  <div className="fr-card-grid">
                    <FriendGrid catalog={catalog} item={item} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {reorderOpen && gallery && (
        <ReorderSheet items={gallery} onReorder={reorderTo} onClose={() => setReorderOpen(false)} />
      )}
    </div>
  );
}

// 순서 편집 — 컴팩트 목록을 드래그해 재정렬(포인터 기반, 라이브러리 없음). 행 높이 고정으로 위치 계산.
const ROW_H = 50;
function ReorderSheet({ items, onReorder, onClose }) {
  const [order, setOrder] = useState(items);
  const [dragId, setDragId] = useState(null);
  const listRef = useRef(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  function onDown(e, id) {
    setDragId(id);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }
  function onMove(e) {
    if (dragId == null || !listRef.current) return;
    const rect = listRef.current.getBoundingClientRect();
    let idx = Math.floor((e.clientY - rect.top) / ROW_H);
    idx = Math.max(0, Math.min(order.length - 1, idx));
    const from = order.findIndex((o) => o.followee_id === dragId);
    if (from === -1 || from === idx) return;
    const next = order.slice();
    const [moved] = next.splice(from, 1);
    next.splice(idx, 0, moved);
    setOrder(next);
  }
  function onUp() {
    if (dragId == null) return;
    setDragId(null);
    onReorder(order.map((o) => o.followee_id));   // 저장 + 갤러리 반영
  }

  return (
    <div className="fr-reorder-overlay" role="presentation" onClick={onClose}>
      <div className="fr-reorder" role="dialog" aria-modal="true" aria-label="친구 순서 편집" onClick={(e) => e.stopPropagation()}>
        <div className="fr-reorder-head">
          <h3 className="fr-reorder-title">순서 편집</h3>
          <button className="btn-add btn-sm" onClick={onClose}>완료</button>
        </div>
        <p className="account-note">손잡이(≡)를 잡고 위아래로 끌어 순서를 바꾸세요.</p>
        <ul className="fr-reorder-list" ref={listRef}>
          {order.map((o) => (
            <li
              key={o.followee_id}
              className={`fr-reorder-row${dragId === o.followee_id ? ' dragging' : ''}`}
              style={{ height: ROW_H }}
              onPointerDown={(e) => onDown(e, o.followee_id)}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            >
              <span className="fr-reorder-handle" aria-hidden="true">≡</span>
              <span className="fr-reorder-name">{o.nickname || o.username}</span>
              {o.nickname && <span className="fr-card-sub">{o.username}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
