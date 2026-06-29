// 기기 지문(해시). 개인 식별 정보가 아니라 '같은 기기' 식별용 SHA-256 해시.
// (익명성 유지: 원자료 저장 안 함, 해시만 서버로 전송)
export async function getDeviceFp() {
  try {
    const parts = [
      navigator.userAgent, navigator.language, navigator.platform || '',
      `${screen.width}x${screen.height}x${screen.colorDepth}`,
      Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      navigator.hardwareConcurrency || '', navigator.maxTouchPoints || '',
    ].join('|');
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}
