// Must be the very first import — see the file for why (ESM import-hoisting
// bug: re-exporting other modules below evaluates them, and the functions
// they define, before any plain statement in this file would otherwise run).
import './src/lib/globalOptions.js';

export {
  signup,
  deleteAccount,
  geoVerify,
  setSignupCode,
  syncAdminClaim,
  purgeExpiredAccounts,
} from './src/auth.js';

export { adminAction } from './src/admin.js';
export { syncProfessors } from './src/syncProfessors.js';

export {
  createTimetable,
  setPrimaryTimetable,
  renameTimetable,
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

export { setNextClassAlerts, setTodaySummaryAlert, nextClassNotify } from './src/nextClass.js';
