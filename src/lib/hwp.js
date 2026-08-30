// .hwp(아래아 한글 5.0, OLE 복합 파일) → 문단 텍스트 추출.
// lib/syllabus.js 의 extractPdf() 와 짝을 이루는 추출기다. PDF와 다른 점:
//  - 글자 좌표가 없다 → 주간 격자 대조(grid.js)는 할 수 없다. grids 는 항상 빈 배열이고,
//    parseSyllabus() 가 그 경우를 이미 '격자를 못 읽은 편람'으로 조용히 건너뛴다.
//  - 페이지 경계가 없다 → 섹션(BodyText/SectionN) 하나가 문서 전체만큼 길 수 있어,
//    호출부가 PDF 페이지만한 크기로 다시 잘라 쓴다(chunkText, lib/syllabus.js).
//
// 구조(HWP 5.0 배포 규격 기준): OLE2(Compound File Binary) 컨테이너 안에
// BodyText/Section0, Section1 … 스트림이 있고, FileHeader 스트림의 속성 플래그
// (오프셋 36, DWORD) bit0 이 1이면 각 스트림은 zlib raw deflate(windowBits 없음)로
// 압축돼 있다. 압축을 풀면 TLV 레코드가 이어지며, 문단 텍스트는 태그 67
// (HWPTAG_PARA_TEXT = HWPTAG_BEGIN(0x10)+51) 에 UTF-16LE 로 들어 있다.
import * as CFB from 'cfb';
import { inflateRaw } from 'pako';

const TAG_PARA_TEXT = 67;

function toBytes(content) {
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

// 레코드 헤더 4바이트(LE): bit0-9 태그ID, bit10-19 레벨, bit20-31 크기
// (0xFFF=4095 이면 크기가 넘쳐 다음 4바이트에 실제 크기가 따로 온다).
function* readRecords(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  while (off + 4 <= bytes.length) {
    const header = dv.getUint32(off, true);
    off += 4;
    const tagId = header & 0x3ff;
    let size = (header >>> 20) & 0xfff;
    if (size === 0xfff) {
      if (off + 4 > bytes.length) break;
      size = dv.getUint32(off, true);
      off += 4;
    }
    if (off + size > bytes.length) break;
    yield { tagId, payload: bytes.subarray(off, off + size) };
    off += size;
  }
}

// 문단 텍스트 속 "인라인 컨트롤 문자"(표·그림·필드·각주 등이 박힌 자리)를 걸러낸다.
// 코드 9(탭)·10/13(문단·줄바꿈)은 글자 1개, 그 외 1~23 범위는 자신을 포함해 총 8개의
// UTF-16 코드유닛을 차지한다(뒤 7개는 텍스트가 아닌 부가정보) — 안 걸러내면 그 부가정보가
// 깨진 글자로 새어나온다. 표 안 셀의 실제 글자는 이 마커가 아니라, 같은 스트림 뒤쪽에
// 별도의 PARA_TEXT 레코드로 이어져 있어 태그만 훑어도 함께 딸려 나온다.
function paraTextToString(payload) {
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.length);
  const n = payload.length >> 1;
  let out = '';
  for (let i = 0; i < n; i++) {
    const code = dv.getUint16(i * 2, true);
    if (code === 9) out += '\t';
    else if (code === 10 || code === 13) out += '\n';
    else if (code >= 1 && code <= 23) i += 7; // 인라인 컨트롤: 마커+부가정보 7유닛 건너뜀
    else if (code > 0) out += String.fromCharCode(code);
  }
  return out;
}

function findAll(cfb, pattern) {
  const out = [];
  cfb.FullPaths.forEach((p, i) => { if (pattern.test(p)) out.push({ path: p, entry: cfb.FileIndex[i] }); });
  return out;
}

// FileHeader 오프셋 36(DWORD): bit0=전체 압축, bit1=암호(비밀번호).
function readFlags(cfb) {
  const fh = CFB.find(cfb, 'FileHeader');
  if (!fh?.content) throw new Error('FileHeader 를 찾지 못했습니다 — HWP 5.0(한글 2002 이상) 형식이 아닐 수 있습니다.');
  const bytes = toBytes(fh.content);
  if (bytes.length < 40) throw new Error('FileHeader 형식이 예상과 다릅니다.');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(36, true);
}

// 반환: { pages, grids }. pages[i] = 섹션 하나(BodyText/SectionN)의 문단 텍스트 전체.
// PDF 의 pages 와 같은 자리에 꽂아 쓸 수 있게 모양을 맞췄다(호출부가 크기로 재분할한다).
export async function extractHwp(file) {
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 8));
  const sig = [...head].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (sig !== 'd0cf11e0a1b11ae1') {
    throw new Error('HWP 5.0(OLE) 형식이 아닙니다. HWPX(.hwpx)나 옛 버전 파일은 지원하지 않습니다 — 한글에서 "HWP 5.0 문서"로 다시 저장해 올려 주세요.');
  }

  const cfb = CFB.read(new Uint8Array(buf), { type: 'array' });
  const flags = readFlags(cfb);
  if (flags & 0x2) throw new Error('암호가 걸린 hwp 파일은 지원하지 않습니다. 암호를 풀고 다시 저장해 주세요.');
  const compressed = (flags & 0x1) === 1;

  const sections = findAll(cfb, /BodyText\/Section\d+$/i)
    .map(({ path, entry }) => ({ no: Number((/Section(\d+)$/i.exec(path) || [])[1] ?? 0), entry }))
    .sort((a, b) => a.no - b.no);
  if (!sections.length) {
    throw new Error('본문(BodyText)을 찾지 못했습니다 — HWP 5.0 형식이 아니거나 손상된 파일일 수 있습니다.');
  }

  const pages = sections.map(({ entry }) => {
    let bytes = toBytes(entry.content);
    if (compressed) {
      try { bytes = inflateRaw(bytes); } catch { /* 이미 풀려 있는 드문 경우 — 원본 그대로 훑는다 */ }
    }
    let text = '';
    for (const { tagId, payload } of readRecords(bytes)) {
      if (tagId === TAG_PARA_TEXT) text += `${paraTextToString(payload)}\n`;
    }
    return text;
  });

  return { pages, grids: [] };
}
