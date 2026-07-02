import { Link } from 'react-router-dom';
import { dayLabel } from '../lib/cache';

// 과목별 파스텔 색 (course/항목 키 순서대로 배정) — 데이터성 값(다크모드와 무관).
const PALETTE = [
  '#dbeafe', '#dcfce7', '#fef9c3', '#fce7f3', '#ede9fe',
  '#ffedd5', '#cffafe', '#fee2e2', '#e0e7ff', '#d1fae5',
];

// "09:00" / "09:00:00" -> 분
function parseHM(t) {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  if (Number.isNaN(h)) return null;
  return h * 60 + (m || 0);
}
const pad2 = (n) => String(n).padStart(2, '0');

// 시간 기준(한 시간 단위 칸) 주간 시간표.
// DB 강의(mine + periods)와 직접 추가한 강의(customClasses)를 하나의 격자에 합쳐 보여준다.
export default function TimetableGrid({ mine = [], periods = [], customClasses = [], onDeleteCustom }) {
  const periodByNo = Object.fromEntries((periods || []).map((p) => [p.no, p]));

  // 색 배정(키별로 안정적)
  const colorByKey = {};
  let ci = 0;
  const colorFor = (k) => (colorByKey[k] ??= PALETTE[ci++ % PALETTE.length]);

  // 모든 강의를 통합 블록으로: { day, startMin, endMin, title, room, color, memoTo?|custom,id }
  const blocks = [];
  (mine || []).forEach((s) =>
    (s.times || []).forEach((t) => {
      const startMin = parseHM(periodByNo[t.start_period]?.start_time);
      const endMin = parseHM(periodByNo[t.end_period]?.end_time);
      if (startMin == null || endMin == null || endMin <= startMin) return;
      blocks.push({
        day: t.day_of_week,
        startMin,
        endMin,
        title: s.course_name,
        room: t.room,
        color: colorFor('c:' + s.course_code),
        memoTo: `/memo/${s.course_code}/${s.year}/${s.term}/${s.section_no}`,
      });
    })
  );
  (customClasses || []).forEach((c) => {
    if (c.startMin == null || c.endMin == null || c.endMin <= c.startMin) return;
    blocks.push({
      day: c.day,
      startMin: c.startMin,
      endMin: c.endMin,
      title: c.title,
      room: c.room,
      color: colorFor('x:' + c.id),
      custom: true,
      id: c.id,
    });
  });

  if (blocks.length === 0) {
    return (
      <div className="empty tt-empty">
        <span className="empty-emoji" aria-hidden="true">🗓️</span>
        <p className="tt-empty-title">아직 시간표가 비어 있어요</p>
        <p className="muted">수업을 검색해 시간표에 추가해 보세요.</p>
        <Link to="/search" className="btn btn-primary tt-empty-cta">🔍 강의 검색하기</Link>
        <p className="tt-empty-hint">DB에 없는 수업은 위 ‘＋ 직접 추가’로 넣을 수 있어요.</p>
      </div>
    );
  }

  // 표시 요일(월~금 + 실제 쓰이는 토/일)
  const usedDays = new Set([1, 2, 3, 4, 5]);
  blocks.forEach((b) => usedDays.add(b.day));
  const days = [...usedDays].sort((a, b) => a - b);

  // 시(hour) 범위
  let minH = Infinity;
  let maxH = -Infinity;
  blocks.forEach((b) => {
    minH = Math.min(minH, Math.floor(b.startMin / 60));
    maxH = Math.max(maxH, Math.ceil(b.endMin / 60));
  });
  const hours = [];
  for (let h = minH; h < maxH; h++) hours.push(h);

  // 좌측 축의 부 눈금: 교시 번호를 "시작 시(hour)" 에 매핑 (예: 1교시 08:10 → 08 행).
  const periodNoByHour = {};
  (periods || []).forEach((p) => {
    const sm = parseHM(p.start_time);
    if (sm != null) periodNoByHour[Math.floor(sm / 60)] = p.no;
  });

  // "요일-시" → 시작 칸에 rowSpan, 나머지 칸은 skip(시작 칸이 덮음)
  const cells = {};
  blocks.forEach((b) => {
    const sH = Math.floor(b.startMin / 60);
    const eH = Math.max(sH + 1, Math.ceil(b.endMin / 60));
    const span = eH - sH;
    for (let h = sH; h < eH; h++) {
      cells[`${b.day}-${h}`] = { ...b, span: h === sH ? span : 0, skip: h !== sH };
    }
  });

  return (
    <div className="tt-wrap">
      <table className="tt">
        <thead>
          <tr>
            <th className="tt-corner" />
            {days.map((d) => (
              <th key={d}>{dayLabel(d)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {hours.map((h) => (
            <tr key={h}>
              <th className="tt-hour">
                {periodNoByHour[h] != null && <span className="tt-period">{periodNoByHour[h]}</span>}
                <span className="tt-h">{pad2(h)}</span>
              </th>
              {days.map((d) => {
                const c = cells[`${d}-${h}`];
                if (c?.skip) return null;
                return (
                  <td key={d} rowSpan={c && c.span > 1 ? c.span : undefined} style={c ? { background: c.color } : undefined}>
                    {c &&
                      (c.custom ? (
                        <button
                          type="button"
                          className="tt-cell tt-cell-custom"
                          title="직접 추가한 강의 — 탭하여 삭제"
                          onClick={() => onDeleteCustom?.(c.id, c.title)}
                        >
                          <span className="tt-course">{c.title}</span>
                          {c.room && <span className="tt-room">{c.room}</span>}
                          <span className="tt-custom-tag">직접</span>
                        </button>
                      ) : (
                        <Link className="tt-cell" to={c.memoTo} title="수업 메모">
                          <span className="tt-course">{c.title}</span>
                          {c.room && <span className="tt-room">{c.room}</span>}
                        </Link>
                      ))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
