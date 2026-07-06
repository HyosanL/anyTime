// =====================================================================
//  족보 파일 스토리지 (Cloudflare R2 via Pages Functions)
//  - 업로드/다운로드/삭제는 동일 출처의 /api/* (Pages Functions)가 처리.
//  - Functions 가 R2 바인딩(EXAM_FILES)으로 직접 put/get/delete (S3 키 불필요).
//  - 인증: Supabase 세션 토큰을 Authorization 으로 전달(_middleware 가 검증).
//  ※ 로컬 vite dev 에서는 /api 가 없으므로 `wrangler pages dev` 로 띄워야 동작.
// =====================================================================
import { supabase } from '../supabase';

async function authHeaders() {
  const { data: { session } } = await supabase.auth.getSession();
  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}

// 족보 보관기간(년). DB의 purge_old_exams() pg_cron 과 동일해야 함.
export const EXAM_RETENTION_YEARS = 5;

// 업로드일 기준 만료일(Date) 계산
export function examExpiry(createdAt) {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return null;
  d.setFullYear(d.getFullYear() + EXAM_RETENTION_YEARS);
  return d;
}

// 행의 첨부파일들을 [{key,name,size,mime}] 로 정규화.
// 첨부는 exam_file 릴레이션(정규화)에 있고, 조회 시 embedded select 로 함께 온다:
//   .select('*, exam_file(seq, object_key, file_name, file_size, mime_type)')
export function examFiles(ex) {
  const rows = Array.isArray(ex?.exam_file) ? [...ex.exam_file] : [];
  rows.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  return rows.map((f) => ({ key: f.object_key, name: f.file_name, size: f.file_size, mime: f.mime_type }));
}

// 업로드 → { key, file_name, file_size, mime_type }
export async function uploadExamFile(courseCode, file) {
  const fd = new FormData();
  fd.append('courseCode', courseCode);
  fd.append('file', file);
  const res = await fetch('/api/exam-upload', {
    method: 'POST',
    headers: await authHeaders(),
    body: fd,
  });
  if (!res.ok) {
    if (res.status === 413) throw new Error('파일이 너무 큽니다(100MB 이하).');
    throw new Error('업로드에 실패했습니다.');
  }
  return res.json();
}

// 여러 파일을 순차 업로드 → [{key,name,size,mime}, ...]
export async function uploadExamFiles(courseCode, files) {
  const out = [];
  for (const f of files) {
    const up = await uploadExamFile(courseCode, f);
    out.push({ key: up.key, name: up.file_name, size: up.file_size, mime: up.mime_type });
  }
  return out;
}

// 다운로드(브라우저 저장) — 인증 헤더로 받아 blob 으로 저장
export async function downloadExam(key, fileName) {
  const res = await fetch(`/api/exam-download?key=${encodeURIComponent(key)}&name=${encodeURIComponent(fileName || 'exam')}`, {
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error('다운로드에 실패했습니다.');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || 'exam';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// 삭제(게시글 비번) → status
export async function deleteExam(id, password) {
  const res = await fetch('/api/exam-delete', {
    method: 'POST',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, password }),
  });
  const body = await res.json().catch(() => ({}));
  return body.status || (res.ok ? 'OK' : 'ERROR');
}
