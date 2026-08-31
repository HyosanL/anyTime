import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';

// Thin wrapper around every onCall Cloud Function, shaped to match the old
// callAdmin()/RPC convention most pages already expect: { ok, status, data }.
// Firebase throws a FunctionsError (e.code like 'permission-denied') instead
// of Supabase's { data, error } tuple — this normalizes that difference so
// most call sites only need their backend call swapped, not their branching.
export async function callFn(name, payload = {}) {
  try {
    const { data } = await httpsCallable(functions, name)(payload);
    return { ok: true, status: data?.status ?? 'OK', data };
  } catch (e) {
    return { ok: false, status: e.code || 'ERROR', message: e.message, data: null };
  }
}
