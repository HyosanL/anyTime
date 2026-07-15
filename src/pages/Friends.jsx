import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthContext } from '../contexts/AuthContext';
import { getCatalog, buildMyTimetable } from '../lib/cache';
import { buildCommonBlocks } from '../lib/commonBlock';
import { setTtPublic, searchSharedUsers, getGallery, followUser, unfollowUser, setNickname } from '../lib/friends';
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
  const [zoom, setZoom] = useState(null);          // 확대해서 보는 항목

  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);    // null = 검색 안 함
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);

  useEffect(() => { getCatalog().then(setCatalog).catch(() => {}); }, []);

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

        {/* 갤러리 */}
        <section className="card">
          <p className="section-label">친구 시간표</p>
          {gallery === null ? (
            <p className="muted center">불러오는 중…</p>
          ) : gallery.length === 0 ? (
            <div className="empty fr-gallery-empty">
              <span className="empty-emoji" aria-hidden="true">🗓️</span>
              <p className="muted">아직 담은 친구가 없어요. 위에서 아이디로 검색해 추가해보세요.</p>
            </div>
          ) : (
            <div className="fr-gallery">
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
                  <button type="button" className="fr-card-grid" onClick={() => item.timetable && setZoom(item)} title="눌러서 확대">
                    <FriendGrid catalog={catalog} item={item} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* 확대 보기 */}
      {zoom && (
        <div className="fr-zoom-overlay" role="presentation" onClick={() => setZoom(null)}>
          <div className="fr-zoom" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="fr-zoom-head">
              <h3 className="fr-zoom-title">
                {zoom.nickname || zoom.username}
                {zoom.timetable && <span className="fr-zoom-sem"> · {zoom.timetable.year}-{zoom.timetable.term}{zoom.timetable.name ? ' ' + zoom.timetable.name : ''}</span>}
              </h3>
              <button className="fr-zoom-x" onClick={() => setZoom(null)} aria-label="닫기">✕</button>
            </div>
            <div className="fr-zoom-body">
              <FriendGrid catalog={catalog} item={zoom} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
