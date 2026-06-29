import { Link } from 'react-router-dom';
import { dayLabel } from '../lib/cache';

// 과목별 파스텔 색 (course_code 순서대로 배정)
const PALETTE = [
  '#dbeafe', '#dcfce7', '#fef9c3', '#fce7f3', '#ede9fe',
  '#ffedd5', '#cffafe', '#fee2e2', '#e0e7ff', '#d1fae5',
];

// 주간 확정시간표 그리드. mine: 등록 분반(시간 포함), periods: 교시 목록.
export default function TimetableGrid({ mine, periods }) {
  // 표시할 요일 (월~금 + 실제 쓰이는 토/일)
  const usedDays = new Set([1, 2, 3, 4, 5]);
  mine.forEach((s) => s.times.forEach((t) => usedDays.add(t.day_of_week)));
  const days = [...usedDays].sort((a, b) => a - b);

  // 표시할 교시 범위
  let minP = Infinity;
  let maxP = -Infinity;
  mine.forEach((s) =>
    s.times.forEach((t) => {
      minP = Math.min(minP, t.start_period);
      maxP = Math.max(maxP, t.end_period);
    })
  );
  if (!isFinite(minP)) {
    return <p className="muted center">확정시간표가 비어 있습니다. 강의를 검색해 추가하세요.</p>;
  }

  // 과목별 색
  const colorByCourse = {};
  let ci = 0;
  mine.forEach((s) => {
    if (!(s.course_code in colorByCourse)) {
      colorByCourse[s.course_code] = PALETTE[ci++ % PALETTE.length];
    }
  });

  // 셀 채우기: "요일-교시" → { label, room, color, isStart }
  const cells = {};
  mine.forEach((s) =>
    s.times.forEach((t) => {
      for (let p = t.start_period; p <= t.end_period; p++) {
        cells[`${t.day_of_week}-${p}`] = {
          label: s.course_name,
          room: t.room,
          color: colorByCourse[s.course_code],
          isStart: p === t.start_period,
          memoTo: `/memo/${s.course_code}/${s.year}/${s.term}/${s.section_no}`,
        };
      }
    })
  );

  const periodByNo = Object.fromEntries(periods.map((p) => [p.no, p]));
  const rows = [];
  for (let p = minP; p <= maxP; p++) rows.push(p);

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
          {rows.map((p) => (
            <tr key={p}>
              <th className="tt-period">
                <span className="tt-pno">{p}</span>
                {periodByNo[p] && (
                  <span className="tt-ptime">{periodByNo[p].start_time?.slice(0, 5)}</span>
                )}
              </th>
              {days.map((d) => {
                const c = cells[`${d}-${p}`];
                return (
                  <td key={d} style={c ? { background: c.color } : undefined}>
                    {c?.isStart && (
                      <Link className="tt-cell" to={c.memoTo} title="수업 메모">
                        <span className="tt-course">{c.label}</span>
                        {c.room && <span className="tt-room">{c.room}</span>}
                      </Link>
                    )}
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
