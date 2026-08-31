# Client-side Supabase → Firebase swap — conventions

Full backend architecture: `docs/superpowers/specs/2026-08-31-firebase-migration-design.md`
(§3 has the exact Firestore collection map, §1 has the write-path split). The
full Cloud Functions surface (53 functions) is exported from
`firebase/functions/index.js` — grep it for the authoritative list of callable
names; every one takes a plain JS object payload and returns `{status, ...}`
or throws an `HttpsError`.

## What already exists (use these, don't recreate them)
- `src/firebase.js` — exports `auth` (Firebase Auth), `db` (Firestore), `functions` (Cloud Functions client).
- `src/lib/functions.js` — `callFn(name, payload)`: calls an onCall Cloud
  Function, returns `{ ok: true, status, data }` on success or
  `{ ok: false, status: e.code, message }` on failure. Use this for every
  Cloud Function call instead of raw `httpsCallable`.
- `src/supabase.js` still exists (other files still use it) — **do not delete
  it or touch files outside your assigned scope**, this is a staged rollout.
  Just stop importing it in the files you rewrite.

## Read/write split (design doc §1) — decide per old Supabase call
- **Owned data** (`timetables`, `gradeEntries`, `rankEntries`, `follows`,
  `favoriteBoards` under `/users/{uid}/...`, plus `ttPublic` on the user doc
  itself): read/write directly with the Firestore SDK
  (`getDoc`/`getDocs`/`setDoc`/`updateDoc`/`deleteDoc`/`onSnapshot`), gated by
  security rules already deployed. Exception: `timetables`/`entries`/
  `customClasses` writes go through Cloud Functions (cross-document
  invariants) — reads are still direct.
- **Catalog** (`professors`, `semesters`, `courses`, `periods`,
  `commonBlocks`, `sections`, `config/app`, `notices`, `bannedWords`):
  direct Firestore reads only, any signed-in user. Writes are Cloud-Functions/
  admin-only (you shouldn't need to write these unless told otherwise).
- **Anonymous/shared data** (`reviews`, `examArchive`, `boardPosts`,
  `comments`, `courseProfessorRatings`, `professorRatings`): direct Firestore
  reads (any signed-in user), but ALL writes go through Cloud Functions
  (`createReview`, `reportReview`, `boardReact`, etc. — see index.js).
- **`classMemos`**: both reads AND writes go through Cloud Functions
  (`getMemos`, `createMemo`, ...) — no direct Firestore read at all, matching
  the old schema's "no SELECT policy" design.
- **`corrections`, `deletedContent`**: no direct client access at all
  (`allow read,write: if false`) — everything through Cloud Functions.

## Auth
- `auth.currentUser` / `onAuthStateChanged(auth, cb)` from `firebase/auth`
  replace `supabase.auth.getSession()`/`onAuthStateChange`.
- `signInWithEmailAndPassword(auth, email, password)` replaces
  `supabase.auth.signInWithPassword`.
- `signOut(auth)` replaces `supabase.auth.signOut()`.
- `updateProfile`/password change: Firebase Auth's `updatePassword(user, newPw)`
  from `firebase/auth` (may require `reauthenticateWithCredential` first if
  Firebase throws `auth/requires-recent-login` — handle that error code).
- Custom claims (`admin`): available on the ID token, refresh via
  `getIdTokenResult(auth.currentUser, true)` after any admin-grant action —
  the claim doesn't update on the client until the token is force-refreshed.
- Username → synthetic email: keep the existing `${username}@anytime.app`
  convention (see whatever `synthEmail()` helper already exists).

## Style
- No WHAT comments. Only WHY (a non-obvious constraint, a security reason, a
  Firestore limitation). Match the terse comment density already in the file
  you're editing.
- Preserve existing exported function names/signatures from the file you're
  rewriting wherever the underlying Cloud Function contract allows it, so
  callers need minimal changes. Where the new backend genuinely requires a
  different payload shape (e.g. a function now needs `year`/`term`/
  `sectionNo` that the old RPC didn't), update every call site in the same
  task — don't leave a mismatched signature for someone else to find.
- Firestore reads that used to be one Supabase `.select()` with multiple
  filters: use `query(collectionRef, where(...), where(...), orderBy(...))`.
  If a query needs a composite index that doesn't exist yet in
  `firebase/firestore.indexes.json`, ADD it there (don't just leave the app
  broken) and say so in your report — indexes get deployed separately.
