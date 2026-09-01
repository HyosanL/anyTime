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
// 2026-09-01: setGlobalOptions 의 ESM import-순서 버그(firebase/functions/src/lib/
// globalOptions.js 참고)를 고쳐 전 함수를 asia-northeast3 로 재배포 — Firestore(같은
// 리전)·사용자 전부 한국이라 이제 리전 하나로 충분하다. authFunctions 는 과거 호환용
// alias(둘 다 같은 값)로 남겨 아직 이걸 import 하는 곳이 있어도 깨지지 않게 한다.
export const functions = getFunctions(app, 'asia-northeast3');
export const authFunctions = functions;
