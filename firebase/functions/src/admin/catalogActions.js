import { randomBytes } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';
import { db, FieldValue, invalid } from '../lib/context.js';

// Port of admin-action/index.ts's catalog branches (professor/semester/course/
// period/commonBlock/section/sectionTime + bulk import + syllabus-metadata
// apply) plus the DB functions they called: gen_course_code(), gen_professor_
// code(), merge_professor(), and the bump_catalog_version() trigger (db/schema.sql).
// Design doc §3 has the Firestore collection map; §1 explains this file is
// half of the single admin gateway (adminAction in ../admin.js calls into
// this map after requireAdmin() already ran — no per-handler auth checks here).
//
// Firestore has no statement-level trigger, so unlike the old schema, EVERY
// handler below that touches a catalog collection (professors/semesters/
// courses/periods/commonBlocks/sections) must increment
// /config/app.catalogVersion itself, in the same batch/transaction as its
// mutation (CONVENTIONS.md).

const CONFIG_APP_REF = () => db.doc('config/app');

function sectionKey(courseCode, year, term, sectionNo) {
  return `${courseCode}_${year}_${term}_${sectionNo}`;
}
function semesterKey(year, term) {
  return `${year}_${term}`;
}
function commonBlockKey(year, term, dayOfWeek, startPeriod) {
  return `${year}_${term}_${dayOfWeek}_${startPeriod}`;
}

// Port of gen_course_code()/gen_professor_code(): generate-then-check-existence,
// retry on collision. Postgres used md5(random()); Admin SDK has no equivalent
// RNG built in, so this uses node:crypto directly — same collision-avoidance
// shape, different randomness source.
export async function genCatalogCode(collectionName, prefix, len) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = prefix + randomBytes(len).toString('hex').slice(0, len).toUpperCase();
    const snap = await db.collection(collectionName).doc(code).get();
    if (!snap.exists) return code;
  }
  throw new HttpsError('internal', '코드 생성에 실패했습니다. 다시 시도하세요.');
}

// Port of ensureSemester() (admin-action/index.ts): create the semester doc
// only if missing, never touch isCurrent on an existing one (upsert with
// ignoreDuplicates in the old code — Firestore has no such flag, so this is a
// plain existence check). Bumps catalogVersion as its own step, same as the
// old code's separate INSERT statement firing bump_catalog_version on its own
// (this function and the caller's own primary mutation were always two
// separate Postgres statements, never one transaction, in the old admin-action
// too — so two independent increments here is not a regression).
async function ensureSemester(year, term) {
  const y = Number(year);
  const t = Number(term);
  if (!Number.isInteger(y) || (t !== 1 && t !== 2)) return;
  const ref = db.collection('semesters').doc(semesterKey(y, t));
  const snap = await ref.get();
  if (snap.exists) return;
  // 새 학기는 숨김으로 시작 — 관리자가 편람을 다 넣고 '수강계획으로 공개'해야
  // 생도 화면(마법사·강의검색·계산기)에 뜬다. 설계 §Ⅰ.
  await ref.set({ year: y, term: t, isCurrent: false, hidden: true });
  await CONFIG_APP_REF().update({ catalogVersion: FieldValue.increment(1) });
}

const BATCH_LIMIT = 400; // headroom under Firestore's 500-mutation batch cap

// Small chunked-batch-commit helper shared by every bulk/cascade handler
// below (bulk_catalog, apply_syllabus_*, delete cascades). Not a general
// "backend API" abstraction (CONVENTIONS.md) — just batch splitting, each
// call site still spells out its own writes explicitly.
async function commitChunked(ops) {
  for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const op of ops.slice(i, i + BATCH_LIMIT)) {
      if (op.type === 'delete') batch.delete(op.ref);
      else if (op.type === 'set') batch.set(op.ref, op.data, op.opts ?? {});
      else batch.update(op.ref, op.data);
    }
    await batch.commit();
  }
}

// =====================================================================
//  professor
// =====================================================================

async function addProfessor(uid, payload) {
  const name = String(payload.name ?? '').trim();
  if (!name) invalid('교수명을 입력하세요.');
  const code = await genCatalogCode('professors', 'P', 6);
  const batch = db.batch();
  batch.set(db.collection('professors').doc(code), { name, department: payload.department ?? null });
  batch.update(CONFIG_APP_REF(), { catalogVersion: FieldValue.increment(1) });
  await batch.commit();
  return { status: 'OK', code };
}

async function setProfessor(uid, payload) {
  const code = String(payload.code ?? '');
  const name = String(payload.name ?? '').trim();
  if (!code || !name) invalid('교수 코드와 이름이 필요합니다.');
  // Matches old upsert(): only code/name/department are ever touched here —
  // office is admin-invisible, managed only by the (inactive) sync-professors job.
  const batch = db.batch();
  batch.set(db.collection('professors').doc(code), { name, department: payload.department ?? null }, { merge: true });
  batch.update(CONFIG_APP_REF(), { catalogVersion: FieldValue.increment(1) });
  await batch.commit();
  return { status: 'OK' };
}

// Pre-merge confirmation: how many sections/reviews does each candidate
// professor code carry (informs which one the admin keeps as `into`).
async function professorUsage(uid, payload) {
  const codes = [...new Set((payload.codes ?? []).map(String).filter(Boolean))].slice(0, 50);
  const usage = {};
  await Promise.all(codes.map(async (code) => {
    const [sectionsCount, reviewsCount] = await Promise.all([
      db.collection('sections').where('professorCode', '==', code).count().get(),
      db.collection('reviews').where('professorCode', '==', code).count().get(),
    ]);
    usage[code] = { sections: sectionsCount.data().count, reviews: reviewsCount.data().count };
  }));
  return { status: 'OK', usage };
}

// Port of merge_professor(): reassigns from's sections/reviews/corrections to
// into, absorbs from's department/office only into into's blank fields, fixes
// up correction.suggested "이름 (코드)" text still pointing at from's old code
// (apply_correction_row resolves that code literally — a stale one would
// resolve to "no such professor" and silently fall through to name-matching),
// then deletes from. Run inside one transaction per code, mirroring the old
// SQL function being one atomic Postgres transaction.
async function mergeProfessorOnce(fromCode, intoCode) {
  return db.runTransaction(async (tx) => {
    const fromRef = db.collection('professors').doc(fromCode);
    const intoRef = db.collection('professors').doc(intoCode);
    const [fromSnap, intoSnap] = await Promise.all([tx.get(fromRef), tx.get(intoRef)]);
    if (!fromSnap.exists || !intoSnap.exists) return { status: 'NOT_FOUND' };

    const [sectionsSnap, reviewsSnap, correctionsSnap, sectionCorrSnap] = await Promise.all([
      tx.get(db.collection('sections').where('professorCode', '==', fromCode)),
      tx.get(db.collection('reviews').where('professorCode', '==', fromCode)),
      tx.get(db.collection('corrections').where('professorCode', '==', fromCode)),
      tx.get(db.collection('corrections').where('target', '==', 'section').where('field', '==', 'professor')),
    ]);

    for (const d of sectionsSnap.docs) tx.update(d.ref, { professorCode: intoCode });
    for (const d of reviewsSnap.docs) tx.update(d.ref, { professorCode: intoCode });
    for (const d of correctionsSnap.docs) tx.update(d.ref, { professorCode: intoCode });

    const suffix = `(${fromCode})`;
    for (const d of sectionCorrSnap.docs) {
      const suggested = d.get('suggested');
      if (typeof suggested === 'string' && suggested.trim().endsWith(suffix)) {
        tx.update(d.ref, { suggested: suggested.replace(new RegExp(`\\(${fromCode}\\)\\s*$`), `(${intoCode})`) });
      }
    }

    const fromData = fromSnap.data();
    const intoData = intoSnap.data();
    const patch = {};
    if (!intoData.department && fromData.department) patch.department = fromData.department;
    if (!intoData.office && fromData.office) patch.office = fromData.office;
    if (Object.keys(patch).length) tx.update(intoRef, patch);

    tx.delete(fromRef);
    tx.update(CONFIG_APP_REF(), { catalogVersion: FieldValue.increment(1) });

    return { status: 'OK', name: fromData.name, sections: sectionsSnap.size, reviews: reviewsSnap.size, corrections: correctionsSnap.size };
  });
}

async function mergeProfessors(uid, payload) {
  const into = String(payload.into ?? '');
  const from = [...new Set((payload.from ?? []).map(String))].filter((c) => c && c !== into);
  if (!into || !from.length) invalid('통합 대상을 지정하세요.');

  let sections = 0;
  let reviews = 0;
  let corrections = 0;
  for (const code of from) {
    const r = await mergeProfessorOnce(code, into);
    if (r.status !== 'OK') return { status: r.status, detail: `교수 ${code}` };
    sections += r.sections;
    reviews += r.reviews;
    corrections += r.corrections;
  }
  return { status: 'OK', merged: from.length, sections, reviews, corrections };
}

// =====================================================================
//  course / semester
// =====================================================================

async function setCourse(uid, payload) {
  const code = String(payload.code ?? '');
  const name = String(payload.name ?? '').trim();
  if (!code || !name) invalid('과목 코드와 이름이 필요합니다.');
  const batch = db.batch();
  batch.set(db.collection('courses').doc(code), { name, department: payload.department ?? null }, { merge: true });
  batch.update(CONFIG_APP_REF(), { catalogVersion: FieldValue.increment(1) });
  await batch.commit();
  return { status: 'OK' };
}

async function addCourse(uid, payload) {
  const name = String(payload.name ?? '').trim();
  if (!name) invalid('과목명을 입력하세요.');
  const code = await genCatalogCode('courses', 'C', 7);
  const batch = db.batch();
  batch.set(db.collection('courses').doc(code), { name, department: payload.department ?? null });
  batch.update(CONFIG_APP_REF(), { catalogVersion: FieldValue.increment(1) });
  await batch.commit();
  return { status: 'OK', code };
}

async function setSemester(uid, payload) {
  const year = Number(payload.year);
  const term = Number(payload.term);
  if (!Number.isInteger(year) || (term !== 1 && term !== 2)) invalid('학기 정보가 올바르지 않습니다.');

  if (payload.isCurrent) {
    const currentSnap = await db.collection('semesters').where('isCurrent', '==', true).get();
    const batch = db.batch();
    for (const d of currentSnap.docs) batch.update(d.ref, { isCurrent: false });
    // 현재 학기는 절대 숨김일 수 없다 — hidden:false 를 함께 박는다.
    batch.set(db.collection('semesters').doc(semesterKey(year, term)),
      { year, term, isCurrent: true, hidden: false }, { merge: true });
    batch.update(CONFIG_APP_REF(), { catalogVersion: FieldValue.increment(1) });
    await batch.commit();
  } else if (payload.hidden === false) {
    // '수강계획으로 공개' — 숨김 해제. 생도가 이 학기 시간표를 짤 수 있게 된다.
    const ref = db.collection('semesters').doc(semesterKey(year, term));
    const snap = await ref.get();
    if (!snap.exists) invalid('먼저 학기를 추가하세요.');
    const batch = db.batch();
    batch.update(ref, { hidden: false });
    batch.update(CONFIG_APP_REF(), { catalogVersion: FieldValue.increment(1) });
    await batch.commit();
  } else {
    // '추가'(다음 학기 미리 열기) — 이미 있으면 손대지 않는다. ensureSemester 가
    // hidden:true 로 생성. upsert 로 덮어쓰면 현재 학기를 강등시키므로 존재 체크만.
    await ensureSemester(year, term);
  }
  return { status: 'OK' };
}

// =====================================================================
//  common block (전 생도 공통 비수업 시간)
// =====================================================================

async function setCommonBlock(uid, payload) {
  const year = Number(payload.year);
  const term = Number(payload.term);
  const dayOfWeek = Number(payload.dayOfWeek);
  const startPeriod = Number(payload.startPeriod);
  if (!Number.isInteger(year) || !Number.isInteger(term) || !dayOfWeek || !startPeriod) {
    invalid('공통공강 정보가 필요합니다.');
  }
  await ensureSemester(year, term);

  const old = payload.old;
  const moved = old?.dayOfWeek != null && (old.dayOfWeek !== dayOfWeek || old.startPeriod !== startPeriod);

  const batch = db.batch();
  if (moved) {
    batch.delete(db.collection('commonBlocks').doc(commonBlockKey(year, term, old.dayOfWeek, old.startPeriod)));
  }
  batch.set(db.collection('commonBlocks').doc(commonBlockKey(year, term, dayOfWeek, startPeriod)), {
    year,
    term,
    dayOfWeek,
    startPeriod,
    endPeriod: payload.endPeriod ?? startPeriod,
    label: String(payload.label ?? '').trim().slice(0, 20),
  });
  batch.update(CONFIG_APP_REF(), { catalogVersion: FieldValue.increment(1) });
  await batch.commit();
  return { status: 'OK' };
}

// =====================================================================
//  period
// =====================================================================

async function setPeriod(uid, payload) {
  const no = Number(payload.no);
  if (!Number.isInteger(no)) invalid('교시 번호가 필요합니다.');
  const batch = db.batch();
  batch.set(db.collection('periods').doc(String(no)), { no, startTime: payload.startTime, endTime: payload.endTime }, { merge: true });
  batch.update(CONFIG_APP_REF(), { catalogVersion: FieldValue.increment(1) });
  await batch.commit();
  return { status: 'OK' };
}

// =====================================================================
//  section / sectionTime (sectionTimes is an embedded array field on the
//  section doc — design doc §3 — so "move" edits that used to be a delete+
//  upsert on a separate PK'd row are now a read-filter-write on that array)
// =====================================================================

async function setSection(uid, payload) {
  const courseCode = String(payload.courseCode ?? '');
  const year = Number(payload.year);
  const term = Number(payload.term);
  const sectionNo = Number(payload.sectionNo);
  if (!courseCode || !Number.isInteger(year) || !Number.isInteger(term) || !Number.isInteger(sectionNo)) {
    invalid('분반 정보가 필요합니다.');
  }
  await ensureSemester(year, term); // 없는 학기면 자동 개설(section 의 FK 대상)
  const batch = db.batch();
  // merge:true — sectionTimes(있다면)는 건드리지 않는다. old section_time 은 별도
  // 테이블이라 이 upsert 와 무관했다; 임베드 배열에서도 동일하게 보존해야 한다.
  batch.set(db.collection('sections').doc(sectionKey(courseCode, year, term, sectionNo)), {
    courseCode, year, term, sectionNo, professorCode: payload.professorCode ?? null,
  }, { merge: true });
  batch.update(CONFIG_APP_REF(), { catalogVersion: FieldValue.increment(1) });
  await batch.commit();
  return { status: 'OK' };
}

async function setSectionTime(uid, payload) {
  const courseCode = String(payload.courseCode ?? '');
  const year = Number(payload.year);
  const term = Number(payload.term);
  const sectionNo = Number(payload.sectionNo);
  const dayOfWeek = Number(payload.dayOfWeek);
  const startPeriod = Number(payload.startPeriod);
  if (!courseCode || !Number.isInteger(year) || !Number.isInteger(term) || !Number.isInteger(sectionNo) || !dayOfWeek || !startPeriod) {
    invalid('강의시간 정보가 필요합니다.');
  }
  const sectionRef = db.collection('sections').doc(sectionKey(courseCode, year, term, sectionNo));
  const old = payload.old;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(sectionRef);
    if (!snap.exists) invalid('분반을 찾을 수 없습니다.');
    let times = snap.get('sectionTimes') || [];
    // old(원래 자리)가 새 자리와 다르면 옛 항목부터 지운다 — PK(day,start) 가 바뀌는
    // 수정은 upsert 만으로 안 되고 old row 를 먼저 지워야 했던 것과 같은 함정.
    if (old?.dayOfWeek != null && (old.dayOfWeek !== dayOfWeek || old.startPeriod !== startPeriod)) {
      times = times.filter((t) => !(t.dayOfWeek === old.dayOfWeek && t.startPeriod === old.startPeriod));
    }
    const entry = { dayOfWeek, startPeriod, endPeriod: payload.endPeriod ?? startPeriod, room: payload.room ?? null };
    const idx = times.findIndex((t) => t.dayOfWeek === dayOfWeek && t.startPeriod === startPeriod);
    if (idx >= 0) times[idx] = entry;
    else times.push(entry);
    tx.update(sectionRef, { sectionTimes: times });
    tx.update(CONFIG_APP_REF(), { catalogVersion: FieldValue.increment(1) });
  });
  return { status: 'OK' };
}

async function deleteSectionTimeEntry(key) {
  const courseCode = String(key?.courseCode ?? '');
  const year = Number(key?.year);
  const term = Number(key?.term);
  const sectionNo = Number(key?.sectionNo);
  const dayOfWeek = Number(key?.dayOfWeek);
  const startPeriod = Number(key?.startPeriod);
  if (!courseCode || !Number.isInteger(year) || !Number.isInteger(term) || !Number.isInteger(sectionNo) || !dayOfWeek || !startPeriod) {
    invalid('강의시간 정보가 필요합니다.');
  }
  const sectionRef = db.collection('sections').doc(sectionKey(courseCode, year, term, sectionNo));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(sectionRef);
    if (!snap.exists) return;
    const times = (snap.get('sectionTimes') || []).filter((t) => !(t.dayOfWeek === dayOfWeek && t.startPeriod === startPeriod));
    tx.update(sectionRef, { sectionTimes: times });
    tx.update(CONFIG_APP_REF(), { catalogVersion: FieldValue.increment(1) });
  });
  return { status: 'OK' };
}

// Shared by delete_catalog(table:'section') and delete_sections: removes the
// section doc plus everything that had an ON DELETE CASCADE FK to it in the
// old schema — timetable_entry (now entries/{sectionKey} docs scattered under
// every cadet's own timetables, found via a collectionGroup query on the
// courseCode/year/term/sectionNo fields addTimetableEntry always sets) and any
// correction row pinned to this exact section (section/section_time targets).
async function deleteSectionCascade(courseCode, year, term, sectionNo) {
  const key = sectionKey(courseCode, year, term, sectionNo);
  const sectionRef = db.collection('sections').doc(key);
  const sectionSnap = await sectionRef.get();
  if (!sectionSnap.exists) return { removed: false, entries: 0 };

  const [entriesSnap, correctionsSnap] = await Promise.all([
    db.collectionGroup('entries')
      .where('courseCode', '==', courseCode).where('year', '==', year)
      .where('term', '==', term).where('sectionNo', '==', sectionNo).get(),
    db.collection('corrections')
      .where('courseCode', '==', courseCode).where('year', '==', year)
      .where('term', '==', term).where('sectionNo', '==', sectionNo).get(),
  ]);

  const ops = [
    ...entriesSnap.docs.map((d) => ({ ref: d.ref, type: 'delete' })),
    ...correctionsSnap.docs
      .filter((d) => d.get('target') === 'section' || d.get('target') === 'section_time')
      .map((d) => ({ ref: d.ref, type: 'delete' })),
    { ref: sectionRef, type: 'delete' },
    { ref: CONFIG_APP_REF(), type: 'update', data: { catalogVersion: FieldValue.increment(1) } },
  ];
  await commitChunked(ops);
  return { removed: true, entries: entriesSnap.size };
}

// =====================================================================
//  delete_catalog — dispatches by table, mirroring the old FK graph
//  (courses/semesters cascade deep; periods are RESTRICT-checked; sections/
//  commonBlocks/sectionTimes are leaves or handled by deleteSectionCascade)
// =====================================================================

async function deleteProfessorCascade(code) {
  if (!code) invalid('교수 코드가 필요합니다.');
  const ref = db.collection('professors').doc(code);
  const snap = await ref.get();
  if (!snap.exists) return { status: 'NOT_FOUND' };

  const [sectionsSnap, reviewsSnap, correctionsSnap] = await Promise.all([
    db.collection('sections').where('professorCode', '==', code).get(),
    db.collection('reviews').where('professorCode', '==', code).get(),
    db.collection('corrections').where('professorCode', '==', code).get(),
  ]);
  await commitChunked([
    ...sectionsSnap.docs.map((d) => ({ ref: d.ref, type: 'update', data: { professorCode: null } })), // old: ON DELETE SET NULL
    ...reviewsSnap.docs.map((d) => ({ ref: d.ref, type: 'update', data: { professorCode: null } })), // old: ON DELETE SET NULL
    ...correctionsSnap.docs.map((d) => ({ ref: d.ref, type: 'delete' })), // old: ON DELETE CASCADE (target='professor' rows only)
    { ref, type: 'delete' },
    { ref: CONFIG_APP_REF(), type: 'update', data: { catalogVersion: FieldValue.increment(1) } },
  ]);
  return { status: 'OK' };
}

async function deleteCourseCascade(code) {
  if (!code) invalid('과목 코드가 필요합니다.');
  const ref = db.collection('courses').doc(code);
  const snap = await ref.get();
  if (!snap.exists) return { status: 'NOT_FOUND' };

  const sectionsSnap = await db.collection('sections').where('courseCode', '==', code).get();
  let entries = 0;
  for (const s of sectionsSnap.docs) {
    const d = s.data();
    const r = await deleteSectionCascade(code, d.year, d.term, d.sectionNo);
    entries += r.entries;
  }
  const correctionsSnap = await db.collection('corrections').where('target', '==', 'course').where('courseCode', '==', code).get();
  await commitChunked([
    ...correctionsSnap.docs.map((d) => ({ ref: d.ref, type: 'delete' })),
    { ref, type: 'delete' },
    { ref: CONFIG_APP_REF(), type: 'update', data: { catalogVersion: FieldValue.increment(1) } },
  ]);
  return { status: 'OK', sections: sectionsSnap.size, entries };
}

async function deleteSemesterCascade(year, term) {
  if (!Number.isInteger(year) || !Number.isInteger(term)) invalid('학기 정보가 필요합니다.');
  const ref = db.collection('semesters').doc(semesterKey(year, term));
  const snap = await ref.get();
  if (!snap.exists) return { status: 'NOT_FOUND' };

  const sectionsSnap = await db.collection('sections').where('year', '==', year).where('term', '==', term).get();
  let entries = 0;
  for (const s of sectionsSnap.docs) {
    const d = s.data();
    const r = await deleteSectionCascade(d.courseCode, d.year, d.term, d.sectionNo);
    entries += r.entries;
  }
  const blocksSnap = await db.collection('commonBlocks').where('year', '==', year).where('term', '==', term).get();

  // timetable(year,term) 도 옛 스키마에서 CASCADE 였다 — 이 학기의 모든 생도 시간표
  // (와 그 안의 entries/customClasses)가 함께 사라진다. recursiveDelete 는
  // runTransaction 안에서 못 쓰므로 batch 밖에서 개별 처리.
  const ttSnap = await db.collectionGroup('timetables').where('year', '==', year).where('term', '==', term).get();
  for (const tt of ttSnap.docs) await db.recursiveDelete(tt.ref);

  await commitChunked([
    ...blocksSnap.docs.map((d) => ({ ref: d.ref, type: 'delete' })),
    { ref, type: 'delete' },
    { ref: CONFIG_APP_REF(), type: 'update', data: { catalogVersion: FieldValue.increment(1) } },
  ]);
  return { status: 'OK', sections: sectionsSnap.size, entries };
}

async function deletePeriodChecked(no) {
  if (!Number.isInteger(no)) invalid('교시 번호가 필요합니다.');
  const ref = db.collection('periods').doc(String(no));
  const snap = await ref.get();
  if (!snap.exists) return { status: 'NOT_FOUND' };

  // Old FK: common_block.start_period/end_period REFERENCES period(no), no ON
  // DELETE clause = RESTRICT. section_time is now embedded in section docs
  // (design doc §3) with no cheap server-side way to check "does any section
  // reference this period" short of scanning every section — deliberately NOT
  // enforced here; only the commonBlocks reference (a real collection) is checked.
  const [startRefs, endRefs] = await Promise.all([
    db.collection('commonBlocks').where('startPeriod', '==', no).limit(1).get(),
    db.collection('commonBlocks').where('endPeriod', '==', no).limit(1).get(),
  ]);
  if (!startRefs.empty || !endRefs.empty) {
    throw new HttpsError('failed-precondition', '이 교시를 참조하는 공통공강이 있어 삭제할 수 없습니다.');
  }

  const batch = db.batch();
  batch.delete(ref);
  batch.update(CONFIG_APP_REF(), { catalogVersion: FieldValue.increment(1) });
  await batch.commit();
  return { status: 'OK' };
}

async function deleteCommonBlock(key) {
  const year = Number(key?.year);
  const term = Number(key?.term);
  const dayOfWeek = Number(key?.dayOfWeek);
  const startPeriod = Number(key?.startPeriod);
  if (!Number.isInteger(year) || !Number.isInteger(term) || !dayOfWeek || !startPeriod) invalid('공통공강 정보가 필요합니다.');
  const batch = db.batch();
  batch.delete(db.collection('commonBlocks').doc(commonBlockKey(year, term, dayOfWeek, startPeriod)));
  batch.update(CONFIG_APP_REF(), { catalogVersion: FieldValue.increment(1) });
  await batch.commit();
  return { status: 'OK' };
}

async function deleteCatalog(uid, payload) {
  const table = String(payload.table ?? '');
  const key = payload.key ?? {};
  switch (table) {
    case 'professor': return deleteProfessorCascade(String(key.code ?? ''));
    case 'course': return deleteCourseCascade(String(key.code ?? ''));
    case 'semester': return deleteSemesterCascade(Number(key.year), Number(key.term));
    case 'period': return deletePeriodChecked(Number(key.no));
    // deleteSectionCascade is the shared low-level helper (course/semester
    // cascades call it too) so it returns {removed, entries}, not the {status}
    // shape callAdmin() keys success off — normalise it for the direct call.
    case 'section': {
      const r = await deleteSectionCascade(String(key.courseCode ?? ''), Number(key.year), Number(key.term), Number(key.sectionNo));
      return { status: r.removed ? 'OK' : 'NOT_FOUND', entries: r.entries };
    }
    case 'sectionTime': return deleteSectionTimeEntry(key);
    case 'commonBlock': return deleteCommonBlock(key);
    default: return invalid('알 수 없는 테이블입니다.'); // invalid() always throws; return keeps every switch arm uniform
  }
}

// =====================================================================
//  bulk import / syllabus apply (관리자 CSV·AI 편람 일괄등록)
// =====================================================================

async function bulkCatalog(uid, payload) {
  const courses = Array.isArray(payload.courses) ? payload.courses : [];

  const semesters = new Set();
  for (const co of courses) for (const se of (co.sections ?? [])) semesters.add(`${se.year}_${se.term}`);
  for (const s of semesters) {
    const [y, t] = s.split('_').map(Number);
    await ensureSemester(y, t);
  }

  const ops = [];
  let created = 0;
  for (const co of courses) {
    const code = await genCatalogCode('courses', 'C', 7);
    ops.push({ ref: db.collection('courses').doc(code), type: 'set', data: { name: co.name, department: co.department ?? null } });
    for (const se of (co.sections ?? [])) {
      const sectionTimes = (se.times ?? []).map((t) => ({
        dayOfWeek: t.day, startPeriod: t.start, endPeriod: t.end ?? t.start, room: t.room ?? null,
      }));
      ops.push({
        ref: db.collection('sections').doc(sectionKey(code, se.year, se.term, se.sectionNo)),
        type: 'set',
        data: { courseCode: code, year: se.year, term: se.term, sectionNo: se.sectionNo, professorCode: se.professorCode ?? null, sectionTimes },
      });
    }
    created++;
  }
  // Old statement-level trigger bumped once per SQL statement, and this loop
  // issued one statement per row anyway (no true multi-row insert) — so a
  // literal port would bump N times for one import. A single increment(1)
  // here is functionally equivalent: clients only ever compare != last-seen
  // (design doc §3), never the magnitude.
  ops.push({ ref: CONFIG_APP_REF(), type: 'update', data: { catalogVersion: FieldValue.increment(1) } });
  await commitChunked(ops);
  return { status: 'OK', created };
}

async function applyCommonBlocks(uid, payload) {
  const year = Number(payload.year);
  const term = Number(payload.term);
  if (!Number.isInteger(year) || !Number.isInteger(term)) invalid('학기 정보가 필요합니다.');
  await ensureSemester(year, term);

  // 재적용이 멱등하도록 그 학기 것을 통째로 지우고 새로 넣는다 — section_time 과
  // 같은 '교체' 의미(편람 전체를 이번 파일 내용으로 대체).
  const existingSnap = await db.collection('commonBlocks').where('year', '==', year).where('term', '==', term).get();
  const rows = (payload.blocks ?? [])
    .filter((b) => b?.day && b?.start && String(b.label ?? '').trim())
    .map((b) => ({ year, term, dayOfWeek: b.day, startPeriod: b.start, endPeriod: b.end ?? b.start, label: String(b.label).trim().slice(0, 20) }));

  await commitChunked([
    ...existingSnap.docs.map((d) => ({ ref: d.ref, type: 'delete' })),
    ...rows.map((r) => ({ ref: db.collection('commonBlocks').doc(commonBlockKey(r.year, r.term, r.dayOfWeek, r.startPeriod)), type: 'set', data: r })),
    { ref: CONFIG_APP_REF(), type: 'update', data: { catalogVersion: FieldValue.increment(1) } },
  ]);
  return { status: 'OK', blocks: rows.length };
}

// AI 편람 일괄등록 1단계: 교시 + 교수. 이름→코드 맵을 돌려줘 2단계(과목/분반)가 쓴다.
async function applySyllabusMeta(uid, payload) {
  const partial = !!payload.partial;
  const ops = [];

  for (const pr of (payload.periods ?? [])) {
    if (pr?.no != null && pr.start && pr.end) {
      ops.push({ ref: db.collection('periods').doc(String(pr.no)), type: 'set', data: { no: pr.no, startTime: pr.start, endTime: pr.end }, opts: { merge: true } });
    }
  }

  const profCodes = {};
  for (const pf of (payload.professors ?? [])) {
    const name = String(pf.name ?? '').trim();
    if (!name) continue;
    let code = pf.code;
    if (!code || pf.create) {
      code = await genCatalogCode('professors', 'P', 6);
      ops.push({ ref: db.collection('professors').doc(code), type: 'set', data: { name, department: pf.department ?? null } });
    } else if (pf.update) {
      if (partial) {
        // 채울 값이 없으면 아무것도 하지 않는다(기존 값 보존) — old code's `continue`
        // here also skips the profCodes[name] assignment below; ported exactly.
        if (!pf.department) continue;
        const snap = await db.collection('professors').doc(code).get();
        if (!(snap.exists && !snap.get('department'))) {
          // 이미 학과가 적혀 있으면 건드리지 않는다(old: q.is('department', null) 필터
          // 가 0행에 매치해 조용히 아무 일도 안 일어나는 것과 동일 — profCodes 는 채운다).
        } else {
          ops.push({ ref: db.collection('professors').doc(code), type: 'update', data: { department: pf.department } });
        }
      } else {
        ops.push({ ref: db.collection('professors').doc(code), type: 'update', data: { department: pf.department ?? null } });
      }
    }
    profCodes[name] = code;
  }

  if (ops.length) {
    ops.push({ ref: CONFIG_APP_REF(), type: 'update', data: { catalogVersion: FieldValue.increment(1) } });
    await commitChunked(ops);
  }
  return { status: 'OK', profCodes };
}

// AI 편람 일괄등록 2단계: 과목(병합/신규) + 분반 + 강의시간.
// partial=true: 이미 있는 분반은 존재만 보장하고, 빈 칸(교수 미정·강의실 미정)만 채운다.
async function applySyllabusCourses(uid, payload) {
  const year = Number(payload.year);
  const term = Number(payload.term);
  const partial = !!payload.partial;
  if (!Number.isInteger(year) || !Number.isInteger(term)) invalid('학기 정보가 필요합니다.');
  await ensureSemester(year, term);

  let nC = 0;
  let nS = 0;
  const ops = [];
  for (const co of (payload.courses ?? [])) {
    let code = co.code;
    if (!code || co.create) {
      code = await genCatalogCode('courses', 'C', 7);
      ops.push({ ref: db.collection('courses').doc(code), type: 'set', data: { name: co.name, department: null } });
      nC++;
    }
    for (const se of (co.sections ?? [])) {
      const sectionRef = db.collection('sections').doc(sectionKey(code, year, term, se.sectionNo));
      const newTimes = (se.times ?? [])
        .filter((t) => t?.day && t?.start)
        .map((t) => ({ dayOfWeek: t.day, startPeriod: t.start, endPeriod: t.end ?? t.start, room: t.room ?? se.room ?? null }));

      if (partial) {
        const snap = await sectionRef.get();
        if (!snap.exists) {
          ops.push({
            ref: sectionRef, type: 'set',
            data: { courseCode: code, year, term, sectionNo: se.sectionNo, professorCode: se.professorCode ?? null, sectionTimes: newTimes },
          });
        } else {
          const data = snap.data();
          const patch = {};
          if (!data.professorCode && se.professorCode) patch.professorCode = se.professorCode;
          const existingTimes = data.sectionTimes ?? [];
          if (existingTimes.length === 0) {
            if (newTimes.length) patch.sectionTimes = newTimes;
          } else if (se.room) {
            // 강의시간은 이미 있으니 건드리지 않고, 강의실 빈 칸만 채운다.
            patch.sectionTimes = existingTimes.map((t) => (t.room ? t : { ...t, room: se.room }));
          }
          if (Object.keys(patch).length) ops.push({ ref: sectionRef, type: 'update', data: patch });
        }
      } else {
        ops.push({
          ref: sectionRef, type: 'set',
          data: { courseCode: code, year, term, sectionNo: se.sectionNo, professorCode: se.professorCode ?? null, sectionTimes: newTimes },
        });
      }
      nS++;
    }
  }
  ops.push({ ref: CONFIG_APP_REF(), type: 'update', data: { catalogVersion: FieldValue.increment(1) } });
  await commitChunked(ops);
  return { status: 'OK', courses: nC, sections: nS };
}

// AI/CSV 일괄등록 3단계(선택): 편람에 없는 잉여 분반 삭제(그 학기를 이 파일로 '대체').
// 삭제 대상 목록은 프런트(reconcile)가 뽑아 명시적으로 넘긴다 — 학기 전체 삭제 사고 방지.
async function deleteSections(uid, payload) {
  const year = Number(payload.year);
  const term = Number(payload.term);
  const list = Array.isArray(payload.sections) ? payload.sections : [];
  let removed = 0;
  let entries = 0;
  for (const s of list) {
    const r = await deleteSectionCascade(String(s.courseCode ?? ''), year, term, Number(s.sectionNo));
    if (r.removed) { removed++; entries += r.entries; }
  }
  return { status: 'OK', removed, entries };
}

export const catalogActions = {
  add_professor: addProfessor,
  set_professor: setProfessor,
  professor_usage: professorUsage,
  merge_professors: mergeProfessors,
  set_course: setCourse,
  add_course: addCourse,
  set_semester: setSemester,
  set_common_block: setCommonBlock,
  set_period: setPeriod,
  set_section: setSection,
  set_section_time: setSectionTime,
  delete_catalog: deleteCatalog,
  bulk_catalog: bulkCatalog,
  apply_common_blocks: applyCommonBlocks,
  apply_syllabus_meta: applySyllabusMeta,
  apply_syllabus_courses: applySyllabusCourses,
  delete_sections: deleteSections,
};
