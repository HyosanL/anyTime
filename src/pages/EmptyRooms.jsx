import { useEffect, useMemo, useState } from 'react';
import BackButton from '../components/BackButton';
import { getCatalog, subscribeCatalog, dayLabel } from '../lib/cache';
import '../styles/rooms.css';

// =====================================================================
//  빈 강의실 찾기 — 시간표 격자에서 요일·교시 칸들을 선택하면, 그 시간에
//  모두 비어 있는 강의실을 보여준다. 카탈로그 캐시(section.sectionTimes[].room)만으로
//  전부 클라이언트에서 계산하므로 서버 요청이 없다(egress 0).
//  "빈 강의실" = 이번 학기 어떤 분반도 그 요일·교시에 쓰지 않는 강의실.
//  강의실 목록 자체도 이번 학기 시간표에 등장하는 강의실로 한정된다.
// =====================================================================

// "HH:MM(:SS)" → "HH:MM"
const hm = (t) => (t ? String(t).slice(0, 5) : '');

// "HH:MM(:SS)" → 분. 실패 시 null.
function parseHM(t) {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  if (Number.isNaN(h)) return null;
  return h * 60 + (m || 0);
}

// JS getDay(0=일..6=토) → DB 규약(1=월..7=일)
function todayDow() {
  const d = new Date().getDay();
  return d === 0 ? 7 : d;
}

const cellKey = (day, periodNo) => `${day}-${periodNo}`;

export default function EmptyRooms() {
  const [catalog, setCatalog] = useState(null);
  const [err, setErr] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [nowMsg, setNowMsg] = useState('');

  useEffect(() => {
    let active = true;
    getCatalog()
      .then((c) => { if (active) setCatalog(c); })
      .catch(() => { if (active) setErr(true); });
    return () => { active = false; };
  }, []);

  // 관리자가 강의 정보를 고치면 재동기화 결과가 여기로 온다 — 켜 둔 화면도 새 강의실 배치로 다시 그린다.
  useEffect(() => subscribeCatalog(setCatalog), []);

  // 현재 학기 강의시간 → 요일·교시별 사용 중 강의실 + 전체 강의실 목록
  const model = useMemo(() => {
    if (!catalog) return null;
    const semesters = catalog.semesters ?? [];
    const current =
      semesters.find((s) => s.isCurrent) ??
      [...semesters].sort((a, b) => b.year - a.year || b.term - a.term)[0];
    if (!current) return { current: null };

    const periods = [...(catalog.periods ?? [])].sort((a, b) => a.no - b.no);
    const occupied = new Map(); // "요일-교시" → Set(강의실)
    const roomSet = new Set();
    const usedDays = new Set([1, 2, 3, 4, 5]);
    for (const sec of catalog.sections ?? []) {
      if (sec.year !== current.year || sec.term !== current.term) continue;
      for (const t of sec.sectionTimes ?? []) {
        usedDays.add(t.dayOfWeek);
        const room = (t.room ?? '').trim();
        if (!room) continue;
        roomSet.add(room);
        for (let p = t.startPeriod; p <= t.endPeriod; p++) {
          const k = cellKey(t.dayOfWeek, p);
          let set = occupied.get(k);
          if (!set) { set = new Set(); occupied.set(k, set); }
          set.add(room);
        }
      }
    }
    const days = [...usedDays].sort((a, b) => a - b);
    const allRooms = [...roomSet].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
    // 칸별 빈 강의실 수는 selected 와 무관 → 여기서 미리 계산(칸 토글마다 전 격자 재계산 방지).
    const freeByCell = new Map();
    for (const d of days) for (const p of periods) {
      const k = cellKey(d, p.no);
      freeByCell.set(k, allRooms.length - (occupied.get(k)?.size ?? 0));
    }
    return { current, periods, days, occupied, allRooms, freeByCell };
  }, [catalog]);

  // 선택한 모든 칸에서 비어 있는 강의실 (선택 없음 → null)
  const freeRooms = useMemo(() => {
    if (!model?.allRooms || selected.size === 0) return null;
    const keys = [...selected];
    return model.allRooms.filter((r) => keys.every((k) => !model.occupied.get(k)?.has(r)));
  }, [model, selected]);

  function toggleCell(day, periodNo) {
    setNowMsg('');
    setSelected((prev) => {
      const next = new Set(prev);
      const k = cellKey(day, periodNo);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  // 머리글 탭: 그 줄(요일 전체/교시 전체)이 모두 선택돼 있으면 해제, 아니면 전체 선택
  function toggleLine(keys) {
    setNowMsg('');
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = keys.every((k) => next.has(k));
      keys.forEach((k) => (allOn ? next.delete(k) : next.add(k)));
      return next;
    });
  }
  const toggleDay = (day) => toggleLine(model.periods.map((p) => cellKey(day, p.no)));
  const togglePeriod = (no) => toggleLine(model.days.map((d) => cellKey(d, no)));

  // 지금(오늘 요일 + 현재 진행 중이거나 다음 교시) 한 칸 선택
  function selectNow() {
    const dow = todayDow();
    if (!model.days.includes(dow)) {
      setNowMsg('오늘은 수업이 없는 요일이에요. 칸을 직접 선택해 주세요.');
      return;
    }
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const cur =
      model.periods.find((p) => {
        const s = parseHM(p.startTime);
        const e = parseHM(p.endTime);
        return s != null && e != null && s <= nowMin && nowMin < e;
      }) ?? model.periods.find((p) => (parseHM(p.startTime) ?? -1) > nowMin);
    if (!cur) {
      setNowMsg('오늘 교시가 모두 끝났어요. 칸을 직접 선택해 주세요.');
      return;
    }
    setSelected(new Set([cellKey(dow, cur.no)]));
    setNowMsg('');
  }

  // "월1, 월2, 화3" 선택 요약
  const selSummary = useMemo(() => {
    if (!selected.size) return '';
    return [...selected]
      .map((k) => k.split('-').map(Number))
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .map(([d, p]) => `${dayLabel(d)}${p}`)
      .join(', ');
  }, [selected]);

  return (
    <div className="page">
      <header className="page-header">
        <BackButton />
        <h2>빈 강의실</h2>
      </header>

      <div className="rooms-body">
        {err ? (
          <p className="error-msg center">강의 데이터를 불러오지 못했습니다. 네트워크 연결 후 다시 시도해 주세요.</p>
        ) : !model ? (
          <p className="muted center">불러오는 중…</p>
        ) : !model.current ? (
          <p className="muted center">학기 정보가 없습니다.</p>
        ) : (
          <>
            <section className="card">
              <div className="rooms-head">
                <h3 className="card-title">{model.current.year}-{model.current.term} 요일·교시 선택</h3>
                <div className="rooms-actions">
                  <button className="btn-ghost btn-sm" onClick={selectNow}>📍 지금</button>
                  <button className="btn-ghost btn-sm" onClick={() => { setSelected(new Set()); setNowMsg(''); }} disabled={!selected.size}>초기화</button>
                </div>
              </div>
              <p className="rooms-hint">
                칸을 눌러 선택하세요. 여러 칸을 고르면 <b>그 시간에 모두 비는</b> 강의실만 보여줘요.
                칸의 숫자는 그 시간의 빈 강의실 수, 요일·교시 머리글을 누르면 줄 전체가 선택돼요.
              </p>
              {nowMsg && <p className="rooms-nowmsg">{nowMsg}</p>}
              <div className="er-wrap">
                <table className="er">
                  <thead>
                    <tr>
                      <th className="er-corner" />
                      {model.days.map((d) => (
                        <th key={d}>
                          <button type="button" className="er-daybtn" onClick={() => toggleDay(d)}>{dayLabel(d)}</button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {model.periods.map((p) => (
                      <tr key={p.no}>
                        <th className="er-period">
                          <button type="button" className="er-pbtn" onClick={() => togglePeriod(p.no)}>
                            <span className="er-pno">{p.no}</span>
                            <span className="er-ptime">{hm(p.startTime)}</span>
                          </button>
                        </th>
                        {model.days.map((d) => {
                          const k = cellKey(d, p.no);
                          const on = selected.has(k);
                          const free = model.freeByCell.get(k) ?? model.allRooms.length;
                          return (
                            <td key={d}>
                              <button
                                type="button"
                                className={`er-cell${on ? ' on' : ''}`}
                                aria-pressed={on}
                                aria-label={`${dayLabel(d)}요일 ${p.no}교시 — 빈 강의실 ${free}곳`}
                                onClick={() => toggleCell(d, p.no)}
                              >
                                {free}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="card">
              <div className="rooms-result-head">
                <h3 className="card-title">
                  빈 강의실{freeRooms ? ` ${freeRooms.length}곳` : ''}
                </h3>
                {selSummary && <span className="rooms-sel">{selSummary}</span>}
              </div>
              {!freeRooms ? (
                <p className="rooms-empty">위에서 요일·교시를 선택하면 빈 강의실을 보여드려요.</p>
              ) : freeRooms.length === 0 ? (
                <p className="rooms-empty">선택한 시간에 모두 비어 있는 강의실이 없어요. 선택을 줄여 보세요.</p>
              ) : (
                <ul className="er-rooms">
                  {freeRooms.map((r) => <li key={r} className="er-room">{r}</li>)}
                </ul>
              )}
              <p className="rooms-caveat">
                시간표에 등록된 <b>정규 수업 기준</b>이에요. 예약·행사·자습 등 실제 사용 여부는 다를 수
                있고, 이번 학기 수업이 하나도 없는 강의실은 목록에 나타나지 않아요.
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
