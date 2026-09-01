// 부작용 전용 모듈 — index.js 맨 위에서 다른 어떤 import 보다 먼저 불러야 한다.
// ESM 은 정적 import 를 소스 순서대로(깊이 우선) 먼저 전부 평가하고 나서야
// 현재 모듈의 본문을 실행한다. index.js 가 `export {...} from './src/auth.js'`
// 식으로 다른 모듈들을 재수출하면, 그 모듈들(과 거기서 만드는 onCall/onRequest
// 정의)이 index.js 본문에 있던 setGlobalOptions() 호출보다 먼저 평가돼버려서
// 리전 설정이 하나도 안 먹혔다(2026-09-01 확인 — 49/54개 함수가 기본값인
// us-central1 로 배포된 원인). 이 파일을 index.js 의 첫 import 로 두면
// setGlobalOptions 가 다른 모든 함수 정의보다 먼저 실행되도록 순서가 보장된다.
import { setGlobalOptions } from 'firebase-functions/v2';

setGlobalOptions({ region: 'asia-northeast3' });
