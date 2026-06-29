// =====================================================================
//  족보 파일 스토리지 추상화 (현재: Supabase Storage)
//  ★ 백엔드 교체 지점 격리: 나중에 Cloudflare R2 로 바꿀 때 이 파일만 교체.
//    - exam_archive.file_url 에는 "버킷 내부 key" 만 저장(전체 URL 금지)
//      → 백엔드를 바꿔도 DB·다른 코드 변경 불필요.
// =====================================================================
import { supabase } from '../supabase';

const BUCKET = 'exam-files';

// 안전한 파일명 (한글/공백 등 제거)
function safeExt(name) {
  const i = name.lastIndexOf('.');
  if (i < 0) return '';
  return name.slice(i).toLowerCase().replace(/[^.a-z0-9]/g, '');
}

// 파일 업로드 → 저장 key 반환 (실패 시 throw)
export async function uploadExamFile(courseCode, file) {
  const key = `${courseCode}/${crypto.randomUUID()}${safeExt(file.name)}`;
  const { error } = await supabase.storage.from(BUCKET).upload(key, file, {
    upsert: false,
    contentType: file.type || 'application/octet-stream',
  });
  if (error) throw error;
  return key;
}

// 다운로드용 signed URL (기본 10분 유효). downloadName 주면 다운로드 트리거.
export async function getDownloadUrl(key, downloadName) {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(key, 600, downloadName ? { download: downloadName } : { download: true });
  if (error) throw error;
  return data.signedUrl;
}
