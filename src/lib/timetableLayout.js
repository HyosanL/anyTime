// 시간표 격자 계산 — 화면(TimetableGrid, DOM)과 이미지 저장(timetableImage, canvas)이
// '똑같은 그림'을 그리도록 블록·격자 계산을 한 곳으로 뺀다.
// 예전엔 둘이 서로 다른 로직으로 블록을 만들어 저장본이 화면과 어긋났다.
import { textOn } from './palettes';

// "09:00" / "09:00:00" -> 분
export function parseHM(t) {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  if (Number.isNaN(h)) return null;
  return h * 60 + (m || 0);
}
export const pad2 = (n) => String(n).padStart(2, '0');

// 모든 강의(DB 분반 mine + 직접추가 customClasses)를 통합 블록으로.
// 색은 키 순서대로 colors[i % n], 글자색 fg 는 타일 밝기로 자동 대비(textOn).
export function buildClassBlocks({ mine = [], periods = [], customClasses = [], colors, showProfessor = true }) {
  const periodByNo = Object.fromEntries((periods || []).map((p) => [p.no, p]));
  const colorByKey = {};
  let ci = 0;
  const colorFor = (k) => (colorByKey[k] ??= colors[ci++ % colors.length]);

  const blocks = [];
  (mine || []).forEach((s) =>
    (s.times || []).forEach((t) => {
      const startMin = parseHM(periodByNo[t.start_period]?.start_time);
      const endMin = parseHM(periodByNo[t.end_period]?.end_time);
      if (startMin == null || endMin == null || endMin <= startMin) return;
      const color = colorFor('c:' + s.course_code);
      blocks.push({
        day: t.day_of_week,
        startMin,
        endMin,
        title: s.course_name,
        meta: [t.room, showProfessor ? s.professor_name : null].filter(Boolean).join(' · '),
        color,
        fg: textOn(color),
        memoTo: `/memo/${s.course_code}/${s.year}/${s.term}/${s.section_no}`,
      });
    })
  );
  (customClasses || []).forEach((c) => {
    if (c.startMin == null || c.endMin == null || c.endMin <= c.startMin) return;
    const color = colorFor('x:' + c.id);
    blocks.push({
      day: c.day,
      startMin: c.startMin,
      endMin: c.endMin,
      title: c.title,
      meta: c.room || '',
      color,
      fg: textOn(color),
      custom: true,
      id: c.id,
    });
  });
  return blocks;
}

// 통합 블록 + 공통 비수업 시간(commonBlocks)으로 격자를 조립한다.
// 반환: { empty } | { days, hours, minH, maxH, periodNoByHour, cells }
//   cells['요일-시'] = 시작 칸이 rowSpan(span>0), 이어지는 칸은 skip.
//     - 수업 칸: { ...block, span, skip }
//     - 공통 공강 칸: { block:true, title, src, span, skip }  (수업 없는 칸에만 깔린다)
export function layoutTimetable({ classBlocks = [], periods = [], commonBlocks = [] }) {
  if (classBlocks.length === 0) return { empty: true };

  // 표시 요일(월~금 + 실제 쓰이는 토/일). 요일은 수업 블록에서만 넓힌다(공통 공강은 시 범위만).
  const usedDays = new Set([1, 2, 3, 4, 5]);
  classBlocks.forEach((b) => usedDays.add(b.day));
  const days = [...usedDays].sort((a, b) => a - b);

  // 시(hour) 범위 — 공통 비수업 시간도 포함해야 그 칸이 격자에 나온다.
  let minH = Infinity;
  let maxH = -Infinity;
  [...classBlocks, ...commonBlocks].forEach((b) => {
    minH = Math.min(minH, Math.floor(b.startMin / 60));
    maxH = Math.max(maxH, Math.ceil(b.endMin / 60));
  });
  const hours = [];
  for (let h = minH; h < maxH; h++) hours.push(h);

  // 좌축 부 눈금: 교시 번호를 '시작 시(hour)'에 매핑.
  const periodNoByHour = {};
  (periods || []).forEach((p) => {
    const sm = parseHM(p.start_time);
    if (sm != null) periodNoByHour[Math.floor(sm / 60)] = p.no;
  });

  // 수업 칸: 시작 칸에 rowSpan, 나머지는 skip.
  const cells = {};
  classBlocks.forEach((b) => {
    const sH = Math.floor(b.startMin / 60);
    const eH = Math.max(sH + 1, Math.ceil(b.endMin / 60));
    const span = eH - sH;
    for (let h = sH; h < eH; h++) {
      cells[`${b.day}-${h}`] = { ...b, span: h === sH ? span : 0, skip: h !== sH };
    }
  });

  // 공통 비수업 시간은 '수업이 없는 칸'에만 깐다 — 수업이 언제나 우선.
  const runs = [];
  commonBlocks.forEach((b) => {
    const sH = Math.floor(b.startMin / 60);
    const eH = Math.max(sH + 1, Math.ceil(b.endMin / 60));
    let run = null;
    for (let h = sH; h < eH; h++) {
      if (cells[`${b.day}-${h}`] || h < minH || h >= maxH) { run = null; continue; }
      if (run && run.endH === h) { run.endH = h + 1; continue; }
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

  return { empty: false, days, hours, minH, maxH, periodNoByHour, cells };
}
