import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { requireAdmin, invalid } from './lib/context.js';
import { pushFanoutUrl, pushFanoutSecret } from './lib/secrets.js';
import { catalogActions } from './admin/catalogActions.js';
import { moderationActions } from './admin/moderationActions.js';

// Port of supabase/functions/admin-action/index.ts — design doc §1: "관리자
// 기능은 거의 전부 SQL 함수가 아니라 Edge Function 하나(admin-action, ~50개
// 분기, service_role)에 있다 — 게이트웨이 함수 하나로 포팅하면 되는 유리한
// 조건." One Cloud Function mirrors that one Edge Function; the ~50 branches
// become entries in catalogActions/moderationActions instead of a giant
// switch, but the single {action, payload} entry point is unchanged —
// src/lib/admin.js's callAdmin() keeps working against this with no shape change.
//
// requireAdmin() runs exactly once, here, before any branch — individual
// handlers never re-check auth (CONVENTIONS.md's "requireAuth/requireAdmin
// discipline").
const actions = { ...catalogActions, ...moderationActions };

// reply_app_report 가 리포트 작성자 기기에 푸시를 보낸다 — 그 한 액션 때문에 시크릿을
// adminAction 전체에 바인딩한다(v2 시크릿은 함수 단위 바인딩, 핸들러 안에서 .value()).
export const adminAction = onCall({ secrets: [pushFanoutUrl, pushFanoutSecret] }, async (request) => {
  const uid = requireAdmin(request);
  const { action, payload = {} } = request.data ?? {};

  // Port of the 'batch' meta-action: the moderation dashboard bundles its
  // ~5 list_* calls into one round trip instead of 5 separate Cloud Functions
  // calls (old comment: unbatched, 15s polling cost 1,200 calls/hr). Read-only
  // list_* handlers only — no side-effecting branch may run through this path.
  if (action === 'batch') {
    const list = Array.isArray(payload.actions) ? payload.actions : [];
    if (list.length > 8) invalid('한 번에 최대 8개까지 조회할 수 있습니다.');
    const results = await Promise.all(list.map(async (a) => {
      const act = String(a?.action ?? '');
      const handler = actions[act];
      if (!act.startsWith('list_') || !handler) {
        return { action: act, ok: false, data: { status: 'BAD_REQUEST' } };
      }
      try {
        const data = await handler(uid, a?.payload ?? {});
        return { action: act, ok: true, data };
      } catch (e) {
        return { action: act, ok: false, data: { status: 'ERROR', detail: e.message } };
      }
    }));
    return { status: 'OK', results };
  }

  const handler = actions[String(action)];
  if (!handler) throw new HttpsError('not-found', `알 수 없는 작업입니다: ${action}`);
  return handler(uid, payload ?? {});
});
