import { memo, useMemo } from 'react';
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
// commonBlocks = 전 생도 공통 비수업 시간(생도대·군사훈련·자율선택형교과).
//   [{ day, startMin, endMin, label }] — 카탈로그(common_block)에서 계산해 온다.
//   DB에 담기지 않는다(생도마다 저장할 이유가 없다) — 격자에만 깔린다.
// showProfessor = 칸에 교수명을 함께 적는다. 교수 상세(한 교수의 담당 시간표)에서는
//   모든 칸이 같은 이름이라 잡음일 뿐이므로 끈다.
function TimetableGrid({ mine = [], periods = [], customClasses = [], commonBlocks = [], showProfessor = true, onDeleteCustom, onHideBlock }) {
  // 격자 파생 계산(blocks·days·hours·cells 등)은 입력이 바뀔 때만 재계산한다.
  // (부모 Home 이 시작 중 여러 번 리렌더돼도 데이터가 그대로면 재계산하지 않음)
  const grid = useMemo(() => {
    const periodByNo = Object.fromEntries((periods || []).map((p) => [p.no, p]));

    // 색 배정(키별로 안정적)
    const colorByKey = {};
    let ci = 0;
    const colorFor = (k) => (colorByKey[k] ??= PALETTE[ci++ % PALETTE.length]);

    // 모든 강의를 통합 블록으로: { day, startMin, endMin, title, meta, color, memoTo?|custom,id }
    // meta = 강의실·교수명(칸이 좁으니 한 줄로 합친다. 전체 문구는 title 속성에 남긴다).
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
          meta: [t.room, showProfessor ? s.professor_name : null].filter(Boolean).join(' · '),
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
        meta: c.room || '',
        color: colorFor('x:' + c.id),
        custom: true,
        id: c.id,
      });
    });

    if (blocks.length === 0) return { empty: true };

    // 표시 요일(월~금 + 실제 쓰이는 토/일)
    const usedDays = new Set([1, 2, 3, 4, 5]);
    blocks.forEach((b) => usedDays.add(b.day));
    const days = [...usedDays].sort((a, b) => a - b);

    // 시(hour) 범위 — 공통 비수업 시간도 포함해야 그 칸이 격자에 나온다
    // (수업이 6교시에 끝나도 7·8교시 자율선택형교과가 보여야 한다).
    let minH = Infinity;
    let maxH = -Infinity;
    [...blocks, ...commonBlocks].forEach((b) => {
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

    // 공통 비수업 시간은 '수업이 없는 칸'에만 깐다 — 수업이 언제나 우선이다.
    // (그 시간에 자율선택형교과를 실제로 듣는 생도는 그 강의가 보여야 한다)
    const runs = [];
    commonBlocks.forEach((b) => {
      const sH = Math.floor(b.startMin / 60);
      const eH = Math.max(sH + 1, Math.ceil(b.endMin / 60));
      let run = null;
      for (let h = sH; h < eH; h++) {
        if (cells[`${b.day}-${h}`] || h < minH || h >= maxH) { run = null; continue; }
        if (run && run.endH === h) { run.endH = h + 1; continue; }
        // src = 원래 블록. 수업이 가운데를 차지해 조각나도 '숨기기'는 블록 전체에 걸린다.
        run = { day: b.day, startH: h, endH: h + 1, title: b.label, src: b };
        runs.push(run);
      }
    });
    runs.forEach((r) => {
      const span = r.endH - r.startH;
      for (let h = r.startH; h < r.endH; h++) {
        cells[`${r.day}-${h}`] = {
          block: true, title: r.title, src: r.src, span: h === r.startH ? span : 0, skip: h !== r.startH,
        };
      }
    });

    return { empty: false, days, hours, periodNoByHour, cells };
  }, [mine, periods, customClasses, commonBlocks, showProfessor]);

  if (grid.empty) {
    return (
      <div className="empty tt-empty">
        <span className="empty-emoji" aria-hidden="true">🗓️</span>
        <p className="tt-empty-title">아직 시간표가 비어 있어요</p>
        <p className="muted">수업을 검색해 시간표에 추가해 보세요.</p>
        <Link to="/search" className="btn btn-primary tt-empty-cta">🔍 강의 검색하기</Link>
        <Link to="/wizard" className="link-btn tt-empty-wiz">🪄 마법사로 한 번에 짜기</Link>
        <p className="tt-empty-hint">DB에 없는 수업은 위 ‘＋ 직접 추가’로 넣을 수 있어요.</p>
      </div>
    );
  }

  const { days, hours, periodNoByHour, cells } = grid;

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
                  <td
                    key={d}
                    className={c?.block ? 'tt-td-block' : undefined}
                    rowSpan={c && c.span > 1 ? c.span : undefined}
                    style={c && !c.block ? { background: c.color } : undefined}
                  >
                    {c && c.block ? (
                      <button
                        type="button"
                        className="tt-cell tt-cell-block"
                        title="공통 공강 시간 — 탭하여 숨기기"
                        onClick={() => onHideBlock?.(c.src)}
                      >
                        <span className="tt-course">{c.title}</span>
                      </button>
                    ) : c &&
                      (c.custom ? (
                        <button
                          type="button"
                          className="tt-cell tt-cell-custom"
                          title="직접 추가한 강의 — 탭하여 삭제"
                          onClick={() => onDeleteCustom?.(c.id, c.title)}
                        >
                          <span className="tt-course">{c.title}</span>
                          {c.meta && <span className="tt-meta">{c.meta}</span>}
                          <span className="tt-custom-tag">직접</span>
                        </button>
                      ) : (
                        /* 칸이 좁아 강의실·교수명은 말줄임될 수 있다 — 전체 문구는 title 로 남긴다 */
                        <Link className="tt-cell" to={c.memoTo} title={`${[c.title, c.meta].filter(Boolean).join(' · ')} — 수업 메모`}>
                          <span className="tt-course">{c.title}</span>
                          {c.meta && <span className="tt-meta">{c.meta}</span>}
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

// 부모(Home)의 무관한 상태 변화로는 리렌더하지 않도록 memo. 입력(mine/periods/customClasses/onDeleteCustom)이
// 같으면 스킵 — Home 의 핸들러는 useCallback 으로 안정화돼 있다.
export default memo(TimetableGrid);
