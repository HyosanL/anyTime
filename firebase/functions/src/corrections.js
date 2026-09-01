import { randomBytes } from 'node:crypto';
import { onCall } from 'firebase-functions/v2/https';
import { db, FieldValue, requireAuth, invalid } from './lib/context.js';
import { pushFanoutUrl, pushFanoutSecret } from './lib/secrets.js';
import { adminPush } from './lib/adminNotify.js';

// Port of submit_correction()/apply_correction_row() (db/schema.sql). The
// `correction` table has NO RLS policy at all in the old schema — submission
// went through submit_correction() (SECURITY DEFINER, no author stored) and
// review/apply went through admin-action (service_role) only. Firestore
// mirrors that exactly: `/corrections/{id}` Rules are `allow read, write: if
// false` — every read and write here happens through the Admin SDK, never
// client-side (design doc §3).

const TARGETS = ['professor', 'course', 'section', 'section_time', 'section_add'];
const FIELDS = ['name', 'department', 'office', 'professor', 'room', 'time', 'section'];

const FIELD_LABELS = {
  time: '요일·교시',
  room: '강의실',
  professor: '담당교수',
  name: '이름/과목명',
  department: '학과',
  office: '연구실',
  section: '분반 추가',
};

const DAY_CHARS = ['월', '화', '수', '목', '금', '토', '일'];
// Mirrors apply_correction_row()'s token regex exactly: one day character +
// a start period + an optional "-"/"~" end period (e.g. "수3-4", "금1",
// "화2~3"). Tokens are split on whitespace/commas; anything not matching
// this shape is silently dropped, not rejected — the old SQL filters tokens
// with `WHERE t ~ '...'` rather than failing the whole submission on junk.
const TOKEN_RE = /^([월화수목금토일])([0-9]+)(?:[-~]([0-9]+))?$/;

function sectionKeyOf(courseCode, year, term, sectionNo) {
  return `${courseCode}_${year}_${term}_${sectionNo}`;
}

function parenCode(text) {
  if (!text) return null;
  const m = /\(([^()]+)\)\s*$/.exec(text);
  return m ? m[1] : null;
}

function parseTimeTokens(text) {
  const tokens = String(text || '').split(/[\s,]+/).filter(Boolean);
  const blocks = [];
  for (const tok of tokens) {
    const m = TOKEN_RE.exec(tok);
    if (!m) continue;
    const dayOfWeek = DAY_CHARS.indexOf(m[1]) + 1;
    let a = parseInt(m[2], 10);
    let b = m[3] != null ? parseInt(m[3], 10) : a;
    if (b < a) [a, b] = [b, a]; // defensive swap for a reversed range like "수4-3"
    blocks.push({ dayOfWeek, startPeriod: a, endPeriod: b });
  }
  return blocks;
}

// Port of `ON CONFLICT (course_code, year, term, section_no, day_of_week,
// start_period) DO NOTHING` — when two tokens land on the same (day, start)
// after parsing, the first one wins and later ones are dropped, rather than
// overwriting.
function dedupBlocks(blocks) {
  const seen = new Set();
  const out = [];
  for (const b of blocks) {
    const key = `${b.dayOfWeek}_${b.startPeriod}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}

// Port of the string_agg(...) that builds v_prev for section_time/field=time
// ("수3-4 금1"), ordered by day then start period.
function formatBlocks(blocks) {
  if (!blocks || !blocks.length) return null;
  return [...blocks]
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startPeriod - b.startPeriod)
    .map((b) => {
      const day = DAY_CHARS[b.dayOfWeek - 1];
      return b.startPeriod === b.endPeriod ? `${day}${b.startPeriod}` : `${day}${b.startPeriod}-${b.endPeriod}`;
    })
    .join(' ');
}

// Port of gen_professor_code(): 'P' + 6 uppercase hex chars, retried until
// unique. A plain (non-transactional) probe — the code is drawn from a huge
// keyspace (16^6), so the vanishingly rare collision race is an accepted
// risk here exactly as it was in the old unlocked SQL loop; doc-ID-as-code
// is the real uniqueness backstop in both versions.
async function genProfessorCode(db) {
  for (;;) {
    const code = 'P' + randomBytes(3).toString('hex').toUpperCase();
    const snap = await db.collection('professors').doc(code).get();
    if (!snap.exists) return code;
  }
}

// Port of the professor-resolution block shared by target=section/professor
// and target=section_add's "prof" field ("이름 (코드)" existing / "이름
// (신규)" create-new / bare "이름" legacy name-match). All reads use `tx`
// so they land before this transaction's first write, per Firestore's
// reads-before-writes rule; a "신규" doc creation is deferred to the caller
// (returned as `newProfessor`) so the caller controls exactly when the
// actual tx.set() happens, keeping every branch's read phase and write
// phase cleanly separated.
async function resolveProfessorCode(tx, db, text) {
  if (!text) return { code: null, newProfessor: null };
  const paren = parenCode(text);
  if (paren === '신규') {
    const name = text.replace(/\s*\([^()]*\)\s*$/, '').trim();
    if (name === '') return { code: null, newProfessor: null };
    const code = await genProfessorCode(db);
    return { code, newProfessor: { code, name } };
  }
  if (paren != null) {
    const snap = await tx.get(db.collection('professors').doc(paren));
    if (snap.exists) return { code: paren, newProfessor: null };
    // Old SQL: `(코드)` present but no such professor falls through to the
    // ELSE branch below (name-match on the FULL suggested string) — it does
    // NOT error. Deliberately not `else` here so this falls into the same
    // name-match as the "no parens at all" case.
  }
  const nameSnap = await tx.get(db.collection('professors').where('name', '==', text.trim()).limit(1));
  return { code: nameSnap.empty ? null : nameSnap.docs[0].id, newProfessor: null };
}

function markApplied(tx, db, correctionRef, prevValue) {
  tx.update(correctionRef, { status: 'applied', prevValue });
  // bump_catalog_version() was a FOR EACH STATEMENT trigger in the old
  // schema, firing once per UPDATE/INSERT statement regardless of rows
  // affected (even 0). Firestore has no statement-level equivalent, and the
  // exact increment magnitude was never a meaningful signal to clients
  // anyway (they only compare catalogVersion for inequality to decide
  // whether to refetch) — so this ports the *intent* ("a catalog mutation
  // happened, invalidate caches") as a flat +1 per successful apply, not an
  // attempt to replicate Postgres's per-statement firing count.
  tx.update(db.collection('config').doc('app'), { catalogVersion: FieldValue.increment(1) });
}

// =====================================================================
//  applyCorrectionRowInternal — port of apply_correction_row(p_id).
//  Plain function (NOT onCall): called from submitCorrection's auto-apply
//  path below AND imported by src/admin/moderationActions.js for manual
//  admin apply. `tx` must be an open Firestore Transaction; this function
//  performs all its reads before any of its writes, and every branch below
//  returns immediately after its own single set of writes — never write
//  twice to the same document inside one call, and never read after this
//  function's first write (Firestore transactions require every tx.get() to
//  precede every tx.set()/update()/delete() in the whole transaction, not
//  just within one function).
//  Returns: 'OK' | 'BAD_TIME' | 'NOT_FOUND' | 'ALREADY_DONE' |
//           'UNSUPPORTED_FIELD' | 'UNSUPPORTED_TARGET'
// =====================================================================
export async function applyCorrectionRowInternal(tx, db, id) {
  const correctionRef = db.collection('corrections').doc(id);
  const cSnap = await tx.get(correctionRef);
  if (!cSnap.exists) return 'NOT_FOUND';
  const c = cSnap.data();
  if (c.status !== 'pending') return 'ALREADY_DONE';
  const v = c.suggested ?? null;

  if (c.target === 'professor') {
    if (!['name', 'department', 'office'].includes(c.field)) return 'UNSUPPORTED_FIELD';
    const profRef = db.collection('professors').doc(c.professorCode);
    const profSnap = await tx.get(profRef);
    // Old professor_code FK was ON DELETE CASCADE, so a pending correction
    // could never outlive its professor there (the correction row would
    // cascade-delete with it) — Firestore has no FK, so this can genuinely
    // happen here. Treated as NOT_FOUND rather than silently marking the
    // suggestion "applied" with nothing actually changed.
    if (!profSnap.exists) return 'NOT_FOUND';
    const prevValue = profSnap.get(c.field) ?? null;
    tx.update(profRef, { [c.field]: v });
    markApplied(tx, db, correctionRef, prevValue);
    return 'OK';
  }

  if (c.target === 'course') {
    if (c.field !== 'name') return 'UNSUPPORTED_FIELD';
    const courseRef = db.collection('courses').doc(c.courseCode);
    const courseSnap = await tx.get(courseRef);
    if (!courseSnap.exists) return 'NOT_FOUND';
    const prevValue = courseSnap.get('name') ?? null;
    tx.update(courseRef, { name: v });
    markApplied(tx, db, correctionRef, prevValue);
    return 'OK';
  }

  if (c.target === 'section') {
    if (c.field !== 'professor') return 'UNSUPPORTED_FIELD';
    const sectionRef = db.collection('sections').doc(sectionKeyOf(c.courseCode, c.year, c.term, c.sectionNo));
    const sectionSnap = await tx.get(sectionRef);
    if (!sectionSnap.exists) return 'NOT_FOUND';
    let prevValue = '교수 미정';
    const curProfCode = sectionSnap.get('professorCode');
    if (curProfCode) {
      const curProfSnap = await tx.get(db.collection('professors').doc(curProfCode));
      prevValue = curProfSnap.exists ? curProfSnap.get('name') : '교수 미정';
    }
    const { code: profCode, newProfessor } = await resolveProfessorCode(tx, db, v);
    if (newProfessor) {
      tx.set(db.collection('professors').doc(newProfessor.code), {
        name: newProfessor.name,
        department: null,
        office: null,
      });
    }
    tx.update(sectionRef, { professorCode: profCode });
    markApplied(tx, db, correctionRef, prevValue);
    return 'OK';
  }

  if (c.target === 'section_time') {
    const sectionRef = db.collection('sections').doc(sectionKeyOf(c.courseCode, c.year, c.term, c.sectionNo));
    const sectionSnap = await tx.get(sectionRef);
    if (!sectionSnap.exists) return 'NOT_FOUND';
    const existingTimes = sectionSnap.get('sectionTimes') || [];

    if (c.field === 'room') {
      // Old SQL sets room on EVERY section_time row for this section (blind
      // bulk UPDATE, no per-block targeting) — same here, uniformly across
      // the whole embedded array.
      const prevValue = existingTimes[0]?.room ?? null;
      tx.update(sectionRef, { sectionTimes: existingTimes.map((t) => ({ ...t, room: v })) });
      markApplied(tx, db, correctionRef, prevValue);
      return 'OK';
    }
    if (c.field === 'time') {
      const blocks = dedupBlocks(parseTimeTokens(v));
      if (!blocks.length) return 'BAD_TIME'; // no valid day/period tokens — refuse rather than wipe existing times
      const prevValue = formatBlocks(existingTimes);
      const room = existingTimes[0]?.room ?? null; // preserve existing room across a time-only edit
      tx.update(sectionRef, { sectionTimes: blocks.map((b) => ({ ...b, room })) });
      markApplied(tx, db, correctionRef, prevValue);
      return 'OK';
    }
    return 'UNSUPPORTED_FIELD';
  }

  if (c.target === 'section_add') {
    // suggested is normalized JSON: {"no":3,"prof":"이름 (코드)|이름 (신규)|","room":"302","times":"수3-4 금1"}
    if (!v) return 'BAD_TIME';
    let json;
    try {
      json = JSON.parse(v);
    } catch {
      return 'BAD_TIME';
    }
    const no = Number(json.no);
    if (!Number.isInteger(no) || no < 1) return 'NOT_FOUND';

    const newSectionRef = db.collection('sections').doc(sectionKeyOf(c.courseCode, c.year, c.term, no));
    const newSectionSnap = await tx.get(newSectionRef);
    if (newSectionSnap.exists) {
      // The section was already created some other way between submission
      // and apply (e.g. admin catalog import) — don't overwrite it, just
      // drain the suggestion (old SQL: same ALREADY_DONE path).
      tx.update(correctionRef, { status: 'applied' });
      return 'ALREADY_DONE';
    }
    const semesterRef = db.collection('semesters').doc(`${c.year}_${c.term}`);
    const semesterSnap = await tx.get(semesterRef);
    const { code: profCode, newProfessor } = await resolveProfessorCode(tx, db, json.prof || null);
    const room = json.room || null;
    // Times are optional for section_add (client marks them required, but
    // like the old SQL this function doesn't re-enforce it — no BAD_TIME
    // here, an empty/invalid `times` just creates a section with no blocks).
    const blocks = dedupBlocks(parseTimeTokens(json.times));

    if (newProfessor) {
      tx.set(db.collection('professors').doc(newProfessor.code), {
        name: newProfessor.name,
        department: null,
        office: null,
      });
    }
    if (!semesterSnap.exists) {
      tx.set(semesterRef, { year: c.year, term: c.term, isCurrent: false });
    }
    tx.set(newSectionRef, {
      courseCode: c.courseCode,
      year: c.year,
      term: c.term,
      sectionNo: no,
      professorCode: profCode,
      sectionTimes: blocks.map((b) => ({ ...b, room })),
    });
    markApplied(tx, db, correctionRef, null);
    return 'OK';
  }

  return 'UNSUPPORTED_TARGET';
}

// =====================================================================
//  submitCorrection — port of submit_correction(). Anonymous by design: no
//  author field is ever written (design doc §4).
// =====================================================================
export const submitCorrection = onCall({ secrets: [pushFanoutUrl, pushFanoutSecret] }, async (request) => {
  requireAuth(request);
  const { target, targetKey, label, field, suggested, note } = request.data ?? {};

  if (!TARGETS.includes(target)) invalid('대상 오류');
  if (!FIELDS.includes(field)) invalid('항목 오류');
  // Free-text ceiling (see board.js createPost): unbounded before, any cadet
  // can call this. suggested holds a normalized token string / small JSON.
  if (suggested != null && String(suggested).length > 2000) invalid('제안 값이 너무 깁니다.');
  if (note != null && String(note).length > 2000) invalid('설명이 너무 깁니다.');
  if (label != null && String(label).length > 300) invalid('대상 이름이 너무 깁니다.');

  const key = targetKey ?? {};
  let professorCode = null;
  let courseCode = null;
  let year = null;
  let term = null;
  let sectionNo = null;

  if (target === 'professor') {
    professorCode = key.code || null;
    if (!professorCode) invalid('대상 키 오류');
  } else if (target === 'course') {
    courseCode = key.code || null;
    if (!courseCode) invalid('대상 키 오류');
  } else if (target === 'section_add') {
    // No section_no: this proposes a section that doesn't exist yet.
    courseCode = key.courseCode || null;
    year = Number.isInteger(key.year) ? key.year : null;
    term = Number.isInteger(key.term) ? key.term : null;
    if (!courseCode || year == null || term == null) invalid('대상 키 오류');
  } else {
    courseCode = key.courseCode || null;
    year = Number.isInteger(key.year) ? key.year : null;
    term = Number.isInteger(key.term) ? key.term : null;
    sectionNo = Number.isInteger(key.sectionNo) ? key.sectionNo : null;
    if (!courseCode || year == null || term == null || sectionNo == null) invalid('대상 키 오류');
  }

  const sug = suggested || null;
  const correctionRef = db.collection('corrections').doc();
  await correctionRef.set({
    target,
    professorCode,
    courseCode,
    year,
    term,
    sectionNo,
    label: label || null,
    field,
    suggested: sug,
    note: note || null,
    status: 'pending',
    autoApplied: false,
    prevValue: null,
    createdAt: FieldValue.serverTimestamp(),
  });

  // "How many pending corrections already match this exact suggestion" —
  // serves both the push-dedup gate (count===1 -> first occurrence) and the
  // auto-apply threshold below. Old SQL ran two near-identical NULL-safe
  // COUNTs (v_dupes for push-dedup, v_cnt for auto-apply) differing only in
  // whether professor_code is compared — irrelevant here, since
  // professor_code is always NULL for every target this function can ever
  // auto-apply (section/section_time/section_add all require
  // professor_code IS NULL per the old correction_target_ref CHECK), so one
  // query correctly serves both purposes.
  const dupeSnap = await db
    .collection('corrections')
    .where('status', '==', 'pending')
    .where('target', '==', target)
    .where('field', '==', field)
    .where('suggested', '==', sug)
    .where('professorCode', '==', professorCode)
    .where('courseCode', '==', courseCode)
    .where('year', '==', year)
    .where('term', '==', term)
    .where('sectionNo', '==', sectionNo)
    .count()
    .get();
  const dupeCount = dupeSnap.data().count;

  // Auto-apply allowlist, ported verbatim from submit_correction()'s
  // v_auto expression:
  //  - section_time.time / section_time.room (요일·교시, 강의실) — narrow
  //    blast radius, touches one section only.
  //  - section.professor, but ONLY when the suggested "(코드)" already names
  //    an EXISTING professor — reassigning to a brand-new professor is
  //    excluded from anonymous auto-apply (spam/abuse guard).
  //  - section_add (분반 추가) always, even when it creates a new professor.
  // Course name / professor name·department·office are NEVER auto-applied
  // (high blast radius, name-collision risk) — they stay pending for manual
  // admin review no matter how many duplicates arrive.
  let isAuto = false;
  if (target === 'section_time' && (field === 'time' || field === 'room')) {
    isAuto = true;
  } else if (target === 'section' && field === 'professor') {
    const code = parenCode(sug);
    if (code) {
      const profSnap = await db.collection('professors').doc(code).get();
      isAuto = profSnap.exists;
    }
  } else if (target === 'section_add') {
    isAuto = true;
  }

  let applied = false;
  if (isAuto && sug != null && dupeCount >= 3) {
    const result = await db.runTransaction((tx) => applyCorrectionRowInternal(tx, db, correctionRef.id));
    if (result === 'OK') {
      applied = true;
      // Best-effort, outside the transaction on purpose: the representative
      // row's actual catalog mutation (above) is the part that must be
      // atomic. Marking sibling duplicates applied/autoApplied is pure
      // admin-UI bookkeeping — old SQL's second bulk UPDATE ran inside the
      // same DB transaction only because Postgres has no read-after-write
      // ordering restriction; Firestore does (see the big comment on
      // applyCorrectionRowInternal), so this has to be a separate commit.
      const siblingsSnap = await db
        .collection('corrections')
        .where('status', '==', 'pending')
        .where('target', '==', target)
        .where('field', '==', field)
        .where('suggested', '==', sug)
        .where('courseCode', '==', courseCode)
        .where('year', '==', year)
        .where('term', '==', term)
        .where('sectionNo', '==', sectionNo)
        .get();
      const groupBatch = db.batch();
      for (const doc of siblingsSnap.docs) {
        groupBatch.update(doc.ref, { status: 'applied', autoApplied: true });
      }
      groupBatch.update(correctionRef, { autoApplied: true });
      await groupBatch.commit();
    }
  }

  // admin_push() swallows its own failures (pushFanout.js) — never let a
  // notification failure fail the submission itself.
  const flabel = FIELD_LABELS[field] || field;
  const pushOpts = { fanoutUrl: pushFanoutUrl.value(), fanoutSecret: pushFanoutSecret.value() };
  if (applied) {
    await adminPush(db, pushOpts, {
      kind: 'auto_correction',
      title: '🤖 수정제안 자동반영됨',
      body: `${label || '대상'} · ${flabel}`,
    });
  } else if (dupeCount === 1) {
    await adminPush(db, pushOpts, {
      kind: 'correction',
      title: '🚩 새 수정 제안',
      body: `${label || '대상'} · ${flabel}`,
    });
  }

  return { id: correctionRef.id };
});
