import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
// firebase/functions/index.js 의 setGlobalOptions({region:'asia-northeast3'})는 auth.js 가
// 함수마다 region:REGION 을 직접 지정하는 것과 달리 다른 모든 모듈에는 적용되지 않아,
// 실제로는 signup/deleteAccount/geoVerify/setSignupCode/syncAdminClaim(auth.js) 5개만
// asia-northeast3 이고 나머지 49개는 기본값인 us-central1 로 배포됐다(2026-09-01 확인).
// 클라이언트는 그래서 리전별로 두 인스턴스를 쓴다 — 대부분은 아래 기본(us-central1),
// auth.js 의 3개 호출(signup/deleteAccount/geoVerify)만 authFunctions(asia-northeast3).
export const functions = getFunctions(app, 'us-central1');
export const authFunctions = getFunctions(app, 'asia-northeast3');
