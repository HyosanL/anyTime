import { onCall } from 'firebase-functions/v2/https';
import { db, requireAuth, invalid, FieldValue } from './lib/context.js';

// Port of timetable/timetable_entry/custom_class + the four trigger functions
// that enforced their invariants (timetable_set_guard, timetable_repromote,
// timetable_entry_check, custom_class_no_overlap) — see db/schema.sql and
// design doc §1/§3. Firestore Security Rules deny all direct client writes
// under /users/{uid}/timetables/** (firestore.rules), so every invariant that
// used to live in a Postgres trigger is re-implemented here, inside a
// db.runTransaction(), instead.

// Mirrors eligibility.js's private sectionKeyOf() — not exported from there,
// so duplicated here rather than editing a shared lib file for one line.
function sectionKeyOf(courseCode, year, term, sectionNo) {
  return `${courseCode}_${year}_${term}_${sectionNo}`;
}

function timetablesCol(uid) {
  return db.collection('users').doc(uid).collection('timetables');
}

// "HH:MM" / "HH:MM:SS" -> minutes since midnight. Assumes /periods/{no} carries
// startTime/endTime as clock strings (mirrors the old Postgres TIME columns
// and the hmToMin() convention already used client-side for custom classes) —
// flagged in the migration report as an assumption to verify against the
// actual catalog-import shape.
function clockToMin(v) {
  if (v == null) return null;
  const [h, m] = String(v).split(':').map(Number);
  if (Number.isNaN(h)) return null;
  return h * 60 + (m || 0);
}

// =====================================================================
//  1. createTimetable — port of the INSERT half of timetable_set_guard()
// =====================================================================
export const createTimetable = onCall(async (request) => {
  const uid = requireAuth(request);
  const { year, term, name, isPrimary } = request.data || {};
  if (!Number.isInteger(year) || !Number.isInteger(term)) invalid('학기 정보가 올바르지 않습니다.');
  if (typeof name !== 'string' || name.length > 20) invalid('시간표 이름은 20자 이하로 입력하세요.');

  return db.runTransaction(async (tx) => {
    const ttCol = timetablesCol(uid);
    // Same query serves the 5-per-semester cap check and (if this timetable
    // is becoming primary) the sibling-demotion pass — one read, two jobs.
    const semSnap = await tx.get(ttCol.where('year', '==', year).where('term', '==', term));
    if (semSnap.size >= 5) invalid('한 학기에 시간표는 5개까지 만들 수 있습니다.');

    // First timetable of the semester is always forced primary (old trigger:
    // `IF v_cnt = 0 THEN NEW.is_primary := TRUE`); otherwise only if asked.
    const wantsPrimary = semSnap.empty || isPrimary === true;
    if (wantsPrimary) {
      for (const doc of semSnap.docs) {
        if (doc.get('isPrimary')) tx.update(doc.ref, { isPrimary: false });
      }
    }

    const ref = ttCol.doc();
    tx.set(ref, {
      year,
      term,
      name,
      isPrimary: wantsPrimary,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { id: ref.id, year, term, name, isPrimary: wantsPrimary };
  });
});

// =====================================================================
//  2. setPrimaryTimetable — explicit "make this the confirmed timetable"
// =====================================================================
export const setPrimaryTimetable = onCall(async (request) => {
  const uid = requireAuth(request);
  const { timetableId } = request.data || {};
  if (!timetableId) invalid('시간표를 지정하세요.');

  await db.runTransaction(async (tx) => {
    const ttCol = timetablesCol(uid);
    const ref = ttCol.doc(timetableId);
    const snap = await tx.get(ref);
    if (!snap.exists) invalid('시간표를 찾을 수 없습니다.');
    const { year, term } = snap.data();

    const siblingSnap = await tx.get(
      ttCol.where('year', '==', year).where('term', '==', term).where('isPrimary', '==', true)
    );
    for (const doc of siblingSnap.docs) {
      if (doc.id !== ref.id) tx.update(doc.ref, { isPrimary: false });
    }
    tx.update(ref, { isPrimary: true });
  });
  return { ok: true };
});

// No SQL/RPC equivalent existed (the old schema let the client UPDATE
// timetable.name directly under RLS) — added because the client's rename
// flow (Home.jsx/TimetableSwitcher.jsx/Wizard.jsx) expects it and
// `timetables/{id}` is blanket `allow write: if false` in firestore.rules,
// same reasoning as every other write in this file.
export const renameTimetable = onCall(async (request) => {
  const uid = requireAuth(request);
  const { timetableId, name } = request.data || {};
  const trimmed = String(name || '').trim();
  if (!timetableId) invalid('시간표를 지정하세요.');
  if (!trimmed) invalid('이름을 입력하세요.');

  const ref = timetablesCol(uid).doc(timetableId);
  const snap = await ref.get();
  if (!snap.exists) invalid('시간표를 찾을 수 없습니다.');
  await ref.update({ name: trimmed });
  return { ok: true };
});

// =====================================================================
//  3. deleteTimetable — port of timetable_repromote() + cascade delete
// =====================================================================
export const deleteTimetable = onCall(async (request) => {
  const uid = requireAuth(request);
  const { timetableId } = request.data || {};
  if (!timetableId) invalid('시간표를 지정하세요.');

  const ttCol = timetablesCol(uid);
  const ref = ttCol.doc(timetableId);
  const snap = await ref.get();
  if (!snap.exists) invalid('시간표를 찾을 수 없습니다.');
  const { year, term, isPrimary } = snap.data();

  // recursiveDelete() deletes the doc AND its entries/customClasses
  // subcollections in one call — Firestore has no ON DELETE CASCADE, and
  // recursiveDelete can't run inside runTransaction(), so the cascade and
  // the repromotion below are two separate steps (not one atomic unit like
  // the old trigger was — acceptable at this app's single-owner-per-write scale).
  await db.recursiveDelete(ref);

  if (isPrimary) {
    await db.runTransaction(async (tx) => {
      const remainSnap = await tx.get(
        ttCol.where('year', '==', year).where('term', '==', term).orderBy('createdAt', 'desc').limit(1)
      );
      if (!remainSnap.empty) tx.update(remainSnap.docs[0].ref, { isPrimary: true });
    });
  }
  return { ok: true };
});

// =====================================================================
//  4/5. addTimetableEntry / removeTimetableEntry — port of timetable_entry_check()
// =====================================================================

// Overlap is checked only within the SAME timetable (old comment: drafts may
// be messy on purpose). Section time blocks compare by period NUMBER, not
// clock time — periods are discrete ordered slots, exactly like the old
// `nt.start_period <= et.end_period AND nt.end_period >= et.start_period`.
async function checkEntryOverlap(tx, ttRef, newTimes) {
  const entriesSnap = await tx.get(ttRef.collection('entries'));
  for (const entryDoc of entriesSnap.docs) {
    const sectionSnap = await tx.get(db.collection('sections').doc(entryDoc.id));
    if (!sectionSnap.exists) continue;
    const otherTimes = sectionSnap.get('sectionTimes') || [];
    for (const nt of newTimes) {
      for (const et of otherTimes) {
        if (nt.dayOfWeek === et.dayOfWeek && nt.startPeriod <= et.endPeriod && nt.endPeriod >= et.startPeriod) {
          invalid('시간표가 겹칩니다. (요일·교시 충돌)');
        }
      }
    }
  }
}

export const addTimetableEntry = onCall(async (request) => {
  const uid = requireAuth(request);
  const { timetableId, courseCode, year, term, sectionNo } = request.data || {};
  if (!timetableId) invalid('시간표를 지정하세요.');
  if (typeof courseCode !== 'string' || !courseCode) invalid('과목을 지정하세요.');
  if (!Number.isInteger(year) || !Number.isInteger(term) || !Number.isInteger(sectionNo)) {
    invalid('분반 정보가 올바르지 않습니다.');
  }

  const sectionKey = sectionKeyOf(courseCode, year, term, sectionNo);

  return db.runTransaction(async (tx) => {
    const ttRef = timetablesCol(uid).doc(timetableId);
    const ttSnap = await tx.get(ttRef);
    if (!ttSnap.exists) invalid('시간표를 찾을 수 없습니다.');
    const tt = ttSnap.data();

    const sectionRef = db.collection('sections').doc(sectionKey);
    const sectionSnap = await tx.get(sectionRef);
    if (!sectionSnap.exists) invalid('해당 분반을 찾을 수 없습니다.');
    const section = sectionSnap.data();

    if (section.year !== tt.year || section.term !== tt.term) {
      invalid(`이 시간표(${tt.year}-${tt.term})와 다른 학기의 분반입니다.`);
    }

    const entryRef = ttRef.collection('entries').doc(sectionKey);
    const entrySnap = await tx.get(entryRef);
    if (entrySnap.exists) invalid('이미 담긴 분반입니다.');

    await checkEntryOverlap(tx, ttRef, section.sectionTimes || []);

    tx.set(entryRef, {
      courseCode,
      year,
      term,
      sectionNo,
      // Required by eligibility.js's timetableHeldDays()/inPrimaryTimetable().
      createdAt: FieldValue.serverTimestamp(),
    });
    return { ok: true };
  });
});

export const removeTimetableEntry = onCall(async (request) => {
  const uid = requireAuth(request);
  const { timetableId, courseCode, year, term, sectionNo } = request.data || {};
  if (!timetableId) invalid('시간표를 지정하세요.');
  if (typeof courseCode !== 'string' || !courseCode) invalid('과목을 지정하세요.');
  if (!Number.isInteger(year) || !Number.isInteger(term) || !Number.isInteger(sectionNo)) {
    invalid('분반 정보가 올바르지 않습니다.');
  }
  // Ownership isn't a separate check — the path is built from the caller's
  // own uid, so there is no way to reach another user's subtree.
  const entryRef = timetablesCol(uid)
    .doc(timetableId)
    .collection('entries')
    .doc(sectionKeyOf(courseCode, year, term, sectionNo));
  await entryRef.delete();
  return { ok: true };
});

// =====================================================================
//  6. addCustomClass / updateCustomClass / deleteCustomClass
//     — port of custom_class_no_overlap()
// =====================================================================

function validateCustomClassFields({ title, day, startMin, endMin }) {
  if (typeof title !== 'string' || !title.trim()) invalid('강의명을 입력하세요.');
  if (!Number.isInteger(day) || day < 1 || day > 7) invalid('요일이 올바르지 않습니다.');
  if (!Number.isInteger(startMin) || startMin < 0 || startMin > 1439) invalid('시작 시각이 올바르지 않습니다.');
  if (!Number.isInteger(endMin) || endMin < 1 || endMin > 1440) invalid('종료 시각이 올바르지 않습니다.');
  if (endMin <= startMin) invalid('종료 시각은 시작 시각보다 늦어야 합니다.');
}

// Minute-granularity overlap: against other custom classes in this timetable,
// AND against catalog sections already added to it — both checks the old
// trigger ran BEFORE INSERT OR UPDATE on custom_class.
async function checkCustomClassOverlap(tx, ttRef, { day, startMin, endMin, excludeId }) {
  const ccSnap = await tx.get(ttRef.collection('customClasses'));
  for (const doc of ccSnap.docs) {
    if (doc.id === excludeId) continue;
    if (doc.get('day') !== day) continue;
    const s = doc.get('startMin');
    const e = doc.get('endMin');
    if (startMin < e && s < endMin) invalid('다른 직접추가 강의와 시간이 겹칩니다.');
  }

  const entriesSnap = await tx.get(ttRef.collection('entries'));
  for (const entryDoc of entriesSnap.docs) {
    const sectionSnap = await tx.get(db.collection('sections').doc(entryDoc.id));
    if (!sectionSnap.exists) continue;
    const times = sectionSnap.get('sectionTimes') || [];
    for (const t of times) {
      if (t.dayOfWeek !== day) continue;
      // Old trigger joins period.start_time/end_time (clock, not period
      // number) here, unlike the entry-vs-entry check above — a custom
      // class is minute-granular, so its overlap must be too.
      const psSnap = await tx.get(db.collection('periods').doc(String(t.startPeriod)));
      const peSnap = await tx.get(db.collection('periods').doc(String(t.endPeriod)));
      if (!psSnap.exists || !peSnap.exists) continue;
      const blockStart = clockToMin(psSnap.get('startTime'));
      const blockEnd = clockToMin(peSnap.get('endTime'));
      if (blockStart == null || blockEnd == null) continue;
      if (startMin < blockEnd && blockStart < endMin) invalid('등록한 강의와 시간이 겹칩니다.');
    }
  }
}

export const addCustomClass = onCall(async (request) => {
  const uid = requireAuth(request);
  const { timetableId, title, day, startMin, endMin, room } = request.data || {};
  if (!timetableId) invalid('시간표를 지정하세요.');
  validateCustomClassFields({ title, day, startMin, endMin });

  return db.runTransaction(async (tx) => {
    const ttRef = timetablesCol(uid).doc(timetableId);
    const ttSnap = await tx.get(ttRef);
    if (!ttSnap.exists) invalid('시간표를 찾을 수 없습니다.');

    await checkCustomClassOverlap(tx, ttRef, { day, startMin, endMin, excludeId: null });

    const ref = ttRef.collection('customClasses').doc();
    tx.set(ref, {
      title: title.trim(),
      day,
      startMin,
      endMin,
      room: room || null,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { id: ref.id };
  });
});

export const updateCustomClass = onCall(async (request) => {
  const uid = requireAuth(request);
  const { timetableId, customClassId, title, day, startMin, endMin, room } = request.data || {};
  if (!timetableId || !customClassId) invalid('직접추가 강의를 지정하세요.');
  validateCustomClassFields({ title, day, startMin, endMin });

  return db.runTransaction(async (tx) => {
    const ttRef = timetablesCol(uid).doc(timetableId);
    const ref = ttRef.collection('customClasses').doc(customClassId);
    const snap = await tx.get(ref);
    if (!snap.exists) invalid('직접추가 강의를 찾을 수 없습니다.');

    await checkCustomClassOverlap(tx, ttRef, { day, startMin, endMin, excludeId: customClassId });

    tx.update(ref, { title: title.trim(), day, startMin, endMin, room: room || null });
    return { ok: true };
  });
});

export const deleteCustomClass = onCall(async (request) => {
  const uid = requireAuth(request);
  const { timetableId, customClassId } = request.data || {};
  if (!timetableId || !customClassId) invalid('직접추가 강의를 지정하세요.');
  await timetablesCol(uid).doc(timetableId).collection('customClasses').doc(customClassId).delete();
  return { ok: true };
});

// =====================================================================
//  7. searchSharedUsers — port of search_shared_users()
// =====================================================================
export const searchSharedUsers = onCall(async (request) => {
  const uid = requireAuth(request);
  const q = String(request.data?.q ?? '').trim();
  if (!q) return [];

  // KNOWN LIMITATION: the old query was `username ILIKE '%q%'` — case-
  // insensitive substring, anywhere in the name. Firestore has no native
  // substring/case-insensitive query without an external search index
  // (Algolia/Typesense/etc.), so this ports only a case-sensitive PREFIX
  // match on `username`. Faithful substring parity is out of reach without
  // adding a search-index integration, which is out of scope here.
  const snap = await db
    .collection('users')
    .where('username', '>=', q)
    .where('username', '<', `${q}`)
    .limit(20)
    .get();

  const results = await Promise.all(
    snap.docs
      .filter((d) => d.id !== uid)
      .map(async (d) => {
        const followSnap = await db.collection('users').doc(uid).collection('follows').doc(d.id).get();
        return {
          id: d.id,
          username: d.get('username'),
          public: d.get('ttPublic') === true,
          following: followSnap.exists,
        };
      })
  );
  // Old ORDER BY tt_public DESC, username — within this prefix-limited
  // candidate set (already alphabetical from the query), re-rank public
  // accounts first.
  results.sort((a, b) => Number(b.public) - Number(a.public));
  return results;
});

// =====================================================================
//  8. getSharedGallery — port of get_shared_gallery()
// =====================================================================

async function galleryRowFor(uid, followDoc, current) {
  const followeeId = followDoc.id;
  const userSnap = await db.collection('users').doc(followeeId).get();
  // Firestore has no ON DELETE CASCADE — if the followee's account was
  // deleted, this follow doc can be orphaned (unlike the old FK CASCADE on
  // tt_follow.followee_id). Skip rather than crash.
  if (!userSnap.exists) return null;

  const isPublic = userSnap.get('ttPublic') === true;
  const row = {
    followeeId,
    username: userSnap.get('username') || '',
    nickname: followDoc.get('nickname') || null,
    public: isPublic,
    timetable: null,
    entries: [],
    customs: [],
    sortOrder: followDoc.get('sortOrder') ?? null,
  };
  if (!isPublic || !current) return row;

  const ttSnap = await db
    .collection('users')
    .doc(followeeId)
    .collection('timetables')
    .where('year', '==', current.year)
    .where('term', '==', current.term)
    .where('isPrimary', '==', true)
    .limit(1)
    .get();
  if (ttSnap.empty) return row;

  const tt = ttSnap.docs[0];
  const [entriesSnap, customsSnap] = await Promise.all([
    tt.ref.collection('entries').get(),
    tt.ref.collection('customClasses').get(),
  ]);
  row.timetable = { id: tt.id, year: tt.get('year'), term: tt.get('term'), name: tt.get('name') };
  row.entries = entriesSnap.docs.map((e) => ({ sectionKey: e.id }));
  row.customs = customsSnap.docs.map((c) => ({
    id: c.id,
    title: c.get('title'),
    day: c.get('day'),
    startMin: c.get('startMin'),
    endMin: c.get('endMin'),
    room: c.get('room') || '',
  }));
  return row;
}

export const getSharedGallery = onCall(async (request) => {
  const uid = requireAuth(request);

  const followSnap = await db.collection('users').doc(uid).collection('follows').get();
  if (followSnap.empty) return [];

  // is_primary is unique per (cadet, year, term) — must pin to the CURRENT
  // semester or a followee's stale confirmed timetable from a past semester
  // would be pulled in instead (old function's ⚠️ comment).
  const semSnap = await db.collection('semesters').where('isCurrent', '==', true).limit(1).get();
  const current = semSnap.empty ? null : { year: semSnap.docs[0].get('year'), term: semSnap.docs[0].get('term') };

  const rows = (await Promise.all(followSnap.docs.map((f) => galleryRowFor(uid, f, current)))).filter(Boolean);

  rows.sort((a, b) => {
    const ao = a.sortOrder;
    const bo = b.sortOrder;
    if (ao == null && bo != null) return 1;
    if (ao != null && bo == null) return -1;
    if (ao != null && bo != null && ao !== bo) return ao - bo;
    return a.username.localeCompare(b.username);
  });
  return rows.map(({ sortOrder, ...r }) => r);
});
