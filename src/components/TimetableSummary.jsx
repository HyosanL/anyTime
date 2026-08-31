import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { buildMyTimetable, dayLabel } from '../lib/cache';
import { minToHM } from '../lib/customClass';

// 수강신청용 요약표. 격자는 '언제 비는가'를 보여주지만, 수강신청 창에 넣을 때 필요한 건
// 과목명·분반·교수명·시간을 한 줄씩 읽어 내려가는 목록이다 — 격자에서 눈으로 옮겨 적지 않게 한다.
// 담긴 분반(entries)은 시간표마다 다르므로, 지금 보고 있지 않은 시간표도 열 수 있게
// 카탈로그 + entries 를 받아 여기서 조립한다(홈이 이미 가진 것이면 요청 0회).

// "08:10:00" → "08:10"
const hm = (t) => (t ? String(t).slice(0, 5) : '');

// 클립보드. writeText 는 문서에 포커스가 없거나 구형 사파리면 거부한다 —
// 그때는 임시 textarea 를 선택해 복사한다(사용자 탭 안에서 실행되므로 허용된다).
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* 아래 폴백 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function toMin(t) {
  const [h, m] = String(t ?? '').split(':').map(Number);
  return Number.isFinite(h) ? h * 60 + (m || 0) : null;
}

// 강의시간 한 칸: 교시("월 1~2교시")와 시각("08:10~10:00")을 나눠 둔다.
// 한 줄로 붙이면 좁은 화면에서 표가 가로로 넘친다 — 수강신청 참고표는 네 열이 한눈에 보여야 한다.
function slotOf(t, periodByNo) {
  const range = t.startPeriod === t.endPeriod
    ? `${t.startPeriod}교시`
    : `${t.startPeriod}~${t.endPeriod}교시`;
  const s = hm(periodByNo[t.startPeriod]?.startTime);
  const e = hm(periodByNo[t.endPeriod]?.endTime);
  return {
    period: `${dayLabel(t.dayOfWeek)} ${range}`,
    clock: s && e ? `${s}~${e}` : '',
  };
}

export default function TimetableSummary({
  catalog,
  timetable,
  entries = [],
  customClasses = [],
  loading = false,   // 캐시조차 아직 안 읽었다(수 ms)
  syncing = false,   // 캐시를 띄운 채 서버 값을 기다리는 중
  onClose,
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 요일·교시 순으로 읽어 내려가게 정렬한다(수강신청 창을 시간 순으로 채우게 된다).
  const rows = useMemo(() => {
    if (!catalog) return [];
    const { mine, periods } = buildMyTimetable(catalog, entries, timetable);
    const periodByNo = Object.fromEntries(periods.map((p) => [p.no, p]));

    const sections = mine.map((s) => {
      const slots = (s.times ?? [])
        .map((t) => ({
          ...slotOf(t, periodByNo),
          sort: t.dayOfWeek * 10000 + (toMin(periodByNo[t.startPeriod]?.startTime) ?? 0),
        }))
        .sort((a, b) => a.sort - b.sort);
      return {
        key: `s:${s.id}`,
        course: s.courseName,
        section: `${s.sectionNo}분반`,
        prof: s.professorName ?? '미정',
        slots,
        sort: slots[0]?.sort ?? Infinity,
      };
    });

    // 직접 추가한 항목(자율학습 등)도 시간표에 '넣어 둔' 것이다 — 빼면 요약이 실제 주간과 어긋난다.
    // 다만 수강신청 대상이 아니므로 분반·교수 자리를 비우고 태그로 구분한다.
    const customs = (customClasses ?? []).map((c) => ({
      key: `x:${c.id}`,
      course: c.title,
      custom: true,
      slots: [{ period: dayLabel(c.day), clock: `${minToHM(c.startMin)}~${minToHM(c.endMin)}` }],
      sort: c.day * 10000 + c.startMin,
    }));

    return [...sections, ...customs].sort(
      (a, b) => a.sort - b.sort || a.course.localeCompare(b.course, 'ko')
    );
  }, [catalog, entries, customClasses, timetable]);

  const courseCount = rows.filter((r) => !r.custom).length;

  const copy = useCallback(async () => {
    const text = [
      `${timetable.year}-${timetable.term} ${timetable.name}`,
      ...rows.map((r) => [
        r.course,
        r.custom ? '직접추가' : r.section,
        r.custom ? '-' : r.prof,
        r.slots.map((s) => {
          if (!s.clock) return s.period;
          return r.custom ? `${s.period} ${s.clock}` : `${s.period} (${s.clock})`;
        }).join(', ') || '시간 미정',
      ].join(' | ')),
    ].join('\n');
    if (await copyToClipboard(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      alert('복사하지 못했습니다. 화면의 표를 그대로 보고 입력해 주세요.');
    }
  }, [rows, timetable]);

  // 홈은 '당겨서 새로고침' 컨테이너 안에 있다. 그 안에 두면 표를 아래로 끄는 터치가
  // 새로고침 제스처로 먹혀(컨테이너 리스너가 preventDefault) 표가 스크롤되지 않는다 → body 로 뺀다.
  return createPortal(
    <div className="tt-sum-overlay" onClick={onClose}>
      <div
        className="tt-sum-modal"
        role="dialog"
        aria-modal="true"
        aria-label="시간표 요약"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tt-sum-head">
          <b>📋 {timetable.year}-{timetable.term} {timetable.name}</b>
          <button type="button" className="tt-sum-x" onClick={onClose} aria-label="닫기">✕</button>
        </div>
        <p className="tt-sum-sub">
          수강신청용 요약 · 강의 {courseCount}개
          {rows.length > courseCount && ` (직접 추가 ${rows.length - courseCount}개 포함)`}
          {syncing && ' · 갱신 중…'}
        </p>

        {!catalog ? (
          <p className="muted center">강의 정보를 아직 받지 못했습니다. 잠시 후 다시 열어 주세요.</p>
        ) : loading && rows.length === 0 ? (
          <p className="muted center">불러오는 중…</p>
        ) : rows.length === 0 ? (
          <p className="muted center">이 시간표에는 담긴 강의가 없습니다.</p>
        ) : (
          <div className="tt-sum-wrap">
            <table className="tt-sum">
              <thead>
                <tr>
                  <th>과목명</th>
                  <th>분반</th>
                  <th>교수명</th>
                  <th>요일·시간</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className={r.custom ? 'is-custom' : undefined}>
                    <td className="tt-sum-course">{r.course}</td>
                    <td>{r.custom ? <span className="tt-sum-tag">직접</span> : r.section}</td>
                    <td className="tt-sum-prof">{r.custom ? '—' : r.prof}</td>
                    <td className="tt-sum-time">
                      {r.slots.length ? r.slots.map((s) => (
                        <span key={s.period + s.clock}>
                          {s.period}
                          {s.clock && <em className="tt-sum-clock">{s.clock}</em>}
                        </span>
                      )) : '시간 미정'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="tt-sum-foot">
          <button type="button" className="btn-ghost btn-sm" disabled={!rows.length} onClick={copy}>
            {copied ? '✅ 복사됨' : '📋 표 복사'}
          </button>
          <button type="button" className="btn-add btn-sm" onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
