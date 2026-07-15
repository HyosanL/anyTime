import { memo, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { dayLabel } from '../lib/cache';
import { paletteByKey, usePalette } from '../lib/palettes';
import { buildClassBlocks, layoutTimetable, pad2 } from '../lib/timetableLayout';

// 시간 기준(한 시간 단위 칸) 주간 시간표.
// DB 강의(mine + periods)와 직접 추가한 강의(customClasses)를 하나의 격자에 합쳐 보여준다.
// commonBlocks = 전 생도 공통 비수업 시간(생도대·군사훈련·자율선택형교과).
//   [{ day, startMin, endMin, label }] — 카탈로그(common_block)에서 계산해 온다.
//   DB에 담기지 않는다(생도마다 저장할 이유가 없다) — 격자에만 깔린다.
// showProfessor = 칸에 교수명을 함께 적는다. 교수 상세(한 교수의 담당 시간표)에서는
//   모든 칸이 같은 이름이라 잡음일 뿐이므로 끈다.
function TimetableGrid({ mine = [], periods = [], customClasses = [], commonBlocks = [], conflictCells = null, showProfessor = true, onDeleteCustom, onHideBlock }) {
  // 사용자가 고른 색 테마 — 바뀌면(다른 화면·시트에서) 이벤트로 여기까지 와서 격자를 재채색한다.
  const [pkey] = usePalette();
  // 격자 파생 계산(blocks·days·hours·cells 등)은 입력이 바뀔 때만 재계산한다.
  // 계산은 화면·이미지가 공유하는 lib/timetableLayout 에 있다(저장본이 화면과 같은 그림이 되도록).
  const grid = useMemo(() => {
    const pal = paletteByKey(pkey);
    const classBlocks = buildClassBlocks({ mine, periods, customClasses, colors: pal.colors, fg: pal.fg, showProfessor });
    return layoutTimetable({ classBlocks, periods, commonBlocks });
  }, [mine, periods, customClasses, commonBlocks, showProfessor, pkey]);

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
                // 겹치는 강의가 있는 칸 — 격자는 한쪽만 그리므로, 이긴 칸을 강조해 '여기 겹침이 있다'를 드러낸다.
                let conflict = false;
                if (c && !c.block && conflictCells?.size) {
                  for (let k = 0; k < (c.span || 1); k++) {
                    if (conflictCells.has(`${d}-${h + k}`)) { conflict = true; break; }
                  }
                }
                return (
                  <td
                    key={d}
                    className={[c?.block ? 'tt-td-block' : '', conflict ? 'tt-td-conflict' : ''].filter(Boolean).join(' ') || undefined}
                    rowSpan={c && c.span > 1 ? c.span : undefined}
                    style={c && !c.block ? { background: c.color, '--cell-fg': c.fg } : undefined}
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
