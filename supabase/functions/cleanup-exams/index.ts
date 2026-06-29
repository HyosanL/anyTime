// =====================================================================
//  애타 (AnyTime) — 족보 보관기간 정리 : cleanup-exams
//  5년 이상 지난 족보(파일+행)를 삭제. 매월 1일 외부 cron 이 호출.
//  보호: 헤더 x-cron-secret === CRON_SECRET (대량삭제 오남용 방지).
//  배포: supabase functions deploy cleanup-exams --no-verify-jwt
//  ※ R2 로 옮기면 파일 삭제부를 R2 객체 삭제로 교체(행 삭제 로직은 동일).
// =====================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RETENTION_YEARS = 5

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method', { status: 405 })
  const secret = req.headers.get('x-cron-secret')
  if (!secret || secret !== Deno.env.get('CRON_SECRET')) {
    return new Response('forbidden', { status: 403 })
  }

  const url = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

  const cutoff = new Date(Date.now() - RETENTION_YEARS * 365.25 * 24 * 3600 * 1000).toISOString()

  // 5년 경과 족보 조회
  const { data: old, error } = await admin
    .from('exam_archive')
    .select('id, file_url')
    .lt('created_at', cutoff)
  if (error) return Response.json({ status: 'ERROR', detail: error.message }, { status: 500 })

  const ids = (old ?? []).map((r) => r.id)
  const files = (old ?? []).map((r) => r.file_url).filter(Boolean)

  if (files.length) await admin.storage.from('exam-files').remove(files)
  if (ids.length) await admin.from('exam_archive').delete().in('id', ids)

  return Response.json({ status: 'OK', deleted: ids.length, cutoff })
})
