// Port of in_primary_timetable()/timetable_held_days(): the review/memo
// write-path eligibility gate — "does this cadet hold this exact section in
// their CURRENT-semester confirmed (primary) timetable?"
//
// Requires that timetable entry docs (`users/{uid}/timetables/{id}/entries/{sectionKey}`)
// carry a `createdAt: FieldValue.serverTimestamp()` field, set when the entry
// is added (see src/timetable.js) — timetableHeldDays() depends on it.

function sectionKeyOf(courseCode, year, term, sectionNo) {
  return `${courseCode}_${year}_${term}_${sectionNo}`;
}

async function primaryTimetableEntry(db, uid, courseCode, year, term, sectionNo) {
  const ttSnap = await db
    .collection('users').doc(uid).collection('timetables')
    .where('year', '==', year).where('term', '==', term).where('isPrimary', '==', true)
    .limit(1).get();
  if (ttSnap.empty) return null;
  const entryDoc = await ttSnap.docs[0].ref
    .collection('entries').doc(sectionKeyOf(courseCode, year, term, sectionNo)).get();
  return entryDoc.exists ? entryDoc : null;
}

export async function inPrimaryTimetable(db, uid, courseCode, year, term, sectionNo) {
  return (await primaryTimetableEntry(db, uid, courseCode, year, term, sectionNo)) !== null;
}

export async function timetableHeldDays(db, uid, courseCode, year, term, sectionNo) {
  const entryDoc = await primaryTimetableEntry(db, uid, courseCode, year, term, sectionNo);
  const createdAt = entryDoc?.get('createdAt');
  if (!createdAt) return 0;
  return Math.floor((Date.now() - createdAt.toMillis()) / 86400000);
}
