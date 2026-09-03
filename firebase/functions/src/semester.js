import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db, FieldValue } from './lib/context.js';

// 날짜 백스톱 — 관리자가 '현재 학기로 설정'을 잊어도, 학기 시작일(1학기 3/1, 2학기 8/1)이
// 지나고 그 학기 편람이 공개돼 있으면 isCurrent 를 자동으로 옮긴다. 앞으로만 움직인다.
// 클라이언트는 이미 semesterPhase.js 로 날짜를 인식하므로(진실의 원천) 이건 백엔드 쿼리
// (getSharedGallery·purgePastMemos) 정확도를 위한 2차 보정이다.
// 설계: docs/superpowers/specs/2026-09-03-semester-lifecycle-and-orientation-design.md §Ⅰ.
//
// semesterForDate 는 src/lib/semesterPhase.js 의 사본이다(functions 는 src/ 를 import 못 함).
// 4줄짜리 순수 함수 — 경계를 바꾸면 두 곳을 함께 고친다.
function semesterForDate(d = new Date()) {
  const m = d.getMonth() + 1;
  if (m >= 3 && m <= 7) return { year: d.getFullYear(), term: 1 };
  if (m >= 8) return { year: d.getFullYear(), term: 2 };
  return { year: d.getFullYear() - 1, term: 2 };
}

const key = (s) => s.year * 10 + s.term;

export const rolloverSemester = onSchedule(
  { schedule: '5 0 * * *', timeZone: 'Asia/Seoul' },
  async () => {
    const snap = await db.collection('semesters').get();
    const sems = snap.docs.map((d) => ({
      ref: d.ref,
      year: Number(d.get('year')),
      term: Number(d.get('term')),
      isCurrent: d.get('isCurrent') === true,
      hidden: d.get('hidden') === true,
    }));
    const visible = sems.filter((s) => !s.hidden);
    if (!visible.length) return;

    const impliedKey = key(semesterForDate(new Date()));
    const target = visible.find((s) => key(s) === impliedKey);
    if (!target || target.isCurrent) return;            // 날짜가 가리키는 학기가 없거나 이미 현재

    const flagged = visible.find((s) => s.isCurrent);
    if (flagged && key(flagged) >= impliedKey) return;  // 앞으로만 — 과거로 강등 안 함

    const batch = db.batch();
    for (const s of sems.filter((x) => x.isCurrent)) batch.update(s.ref, { isCurrent: false });
    batch.update(target.ref, { isCurrent: true, hidden: false });
    batch.update(db.doc('config/app'), { catalogVersion: FieldValue.increment(1) });
    await batch.commit();
  }
);
