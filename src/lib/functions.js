import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';

// Thin wrapper around every onCall Cloud Function, shaped to match the old
// callAdmin()/RPC convention most pages already expect: { ok, status, data }.
// Firebase throws a FunctionsError (e.code like 'permission-denied') instead
// of Supabase's { data, error } tuple — this normalizes that difference so
// most call sites only need their backend call swapped, not their branching.
//
// fnInstance: defaults to the us-central1 instance (where 49 of 54 functions
// actually deployed — setGlobalOptions() in firebase/functions/index.js
// doesn't override auth.js's per-function region:'asia-northeast3'). Callers
// hitting one of the 3 client-callable auth.js functions (signup/deleteAccount/
// geoVerify) must pass `authFunctions` from '../firebase' explicitly.
export async function callFn(name, payload = {}, fnInstance = functions) {
  try {
    const { data } = await httpsCallable(fnInstance, name)(payload);
    return { ok: true, status: data?.status ?? 'OK', data };
  } catch (e) {
    return { ok: false, status: e.code || 'ERROR', message: e.message, data: null };
  }
}
