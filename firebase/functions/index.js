import { setGlobalOptions } from 'firebase-functions/v2';

// Default region for every function below that doesn't set its own — most
// don't (auth.js is the one exception, setting `region: REGION` locally per
// function; harmless overlap with this default, both resolve to the same
// value). Matches firestore.rules/firestore.indexes.json's asia-northeast3.
setGlobalOptions({ region: 'asia-northeast3' });

export {
  signup,
  deleteAccount,
  geoVerify,
  setSignupCode,
  syncAdminClaim,
  purgeExpiredAccounts,
} from './src/auth.js';

export { adminAction } from './src/admin.js';

export {
  createTimetable,
  setPrimaryTimetable,
  deleteTimetable,
  addTimetableEntry,
  removeTimetableEntry,
  addCustomClass,
  updateCustomClass,
  deleteCustomClass,
  searchSharedUsers,
  getSharedGallery,
} from './src/timetable.js';

export {
  createReview,
  deleteReview,
  likeReview,
  reportReview,
  onReviewWritten,
} from './src/reviews.js';

export { createExam, deleteExam, purgeOldExams } from './src/examArchive.js';

export {
  createMemo,
  getMemos,
  deleteMemo,
  reportMemo,
  purgePastMemos,
} from './src/classMemo.js';

export { submitCorrection } from './src/corrections.js';

export {
  createBoard,
  createPost,
  getPost,
  boardReact,
  createComment,
  deletePost,
  deleteComment,
  createShare,
  getSharedPost,
  shareImageOk,
  boardReferencedKeys,
  purgeBoard,
  onCommentCreatedPush,
  onPostHotChangedPush,
} from './src/board.js';

export {
  pushSubscribe,
  pushUnsubscribe,
  pushSetHot,
  pushWatch,
  pushUnwatch,
  pushPrune,
  adminPushSubscribe,
  adminPushUnsubscribe,
} from './src/push.js';
