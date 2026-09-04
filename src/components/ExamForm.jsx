import { useState } from 'react';
import { callFn } from '../lib/functions';
import { uploadExamFiles, EXAM_RETENTION_YEARS } from '../lib/storage';
import { maskText, prefetchMask } from '../lib/mask';
import DeletePasswordField from './DeletePasswordField';

const TYPES = ['중간고사', '기말고사', '퀴즈', '과제', '기타'];
const CUR_YEAR = new Date().getFullYear();
const MIN_YEAR = 2000;
const MAX_FILES = 10;

// 족보 업로드 폼: 파일(다중) → R2 업로드(storage.js, 이관 범위 밖) → createExam Cloud Function(메타+files).
export default function ExamForm({ courseCode, onDone }) {
  const [title, setTitle] = useState('');
  const [examType, setExamType] = useState('중간고사');
  const [srcYear, setSrcYear] = useState(CUR_YEAR);
  const [srcTerm, setSrcTerm] = useState('');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState([]); // File[]
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function pickFiles(list) {
    const picked = Array.from(list || []);
    setFiles((prev) => {
      // 이름+크기로 중복 제거하고 이어붙임(여러 번 선택해도 누적)
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      const merged = [...prev];
      for (const f of picked) {
        const k = `${f.name}:${f.size}`;
        if (!seen.has(k)) { seen.add(k); merged.push(f); }
      }
      return merged.slice(0, MAX_FILES);
    });
  }
  const removeFile = (i) => setFiles((prev) => prev.filter((_, idx) => idx !== i));

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!title.trim()) return setError('제목을 입력하세요.');
    if (files.length === 0) return setError('파일을 선택하세요.');
    if (files.length > MAX_FILES) return setError(`파일은 최대 ${MAX_FILES}개까지 첨부할 수 있습니다.`);
    if (files.some((f) => f.size > 100 * 1024 * 1024)) return setError('각 파일은 100MB 이하여야 합니다.');

    setSubmitting(true);
    try {
      const uploaded = await uploadExamFiles(courseCode, files); // [{key,name,size,mime}]
      const r = await callFn('createExam', {
        courseCode,
        srcYear,
        srcTerm: srcTerm ? Number(srcTerm) : null,
        title: await maskText(title.trim()),
        examType,
        description: (await maskText(description.trim())) || null,
        files: uploaded,   // createExam 이 embedded files 배열로 그대로 저장
        postPassword: password,
      });
      if (!r.ok) {
        setError(r.message || '등록에 실패했습니다.');
        return;
      }
      onDone?.();
    } catch (err) {
      setError(err.message || '업로드에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="rev-form" onSubmit={handleSubmit}>
      <label className="field rev-form-field">
        <span className="field-label">제목</span>
        {/* 입력창에 손을 대면 그때 비속어 사전을 미리 받는다(제출 때 기다리지 않도록) */}
        <input value={title} onFocus={prefetchMask} onChange={(e) => setTitle(e.target.value)} placeholder="예: 2025-2 중간 정리" />
      </label>

      <div className="exam-row">
        <label className="field rev-form-field">
          <span className="field-label">종류</span>
          <select value={examType} onChange={(e) => setExamType(e.target.value)}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <div className="field rev-form-field">
          <span className="field-label">연도</span>
          <div className="year-stepper">
            <button
              type="button" className="year-step-btn" aria-label="연도 낮추기"
              onClick={() => setSrcYear((y) => Math.max(MIN_YEAR, y - 1))}
              disabled={srcYear <= MIN_YEAR}
            >−</button>
            <span className="year-step-val">{srcYear}</span>
            <button
              type="button" className="year-step-btn" aria-label="연도 높이기"
              onClick={() => setSrcYear((y) => Math.min(CUR_YEAR, y + 1))}
              disabled={srcYear >= CUR_YEAR}
            >＋</button>
          </div>
        </div>
        <label className="field rev-form-field">
          <span className="field-label">학기</span>
          <select value={srcTerm} onChange={(e) => setSrcTerm(e.target.value)}>
            <option value="">-</option>
            <option value="1">1</option>
            <option value="2">2</option>
          </select>
        </label>
      </div>

      <label className="field rev-form-field">
        <span className="field-label">설명</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="내용·출처 등(선택)" />
      </label>

      <div className="field rev-form-field">
        <span className="field-label">파일 (각 100MB 이하 · 최대 {MAX_FILES}개)</span>
        <label className="exam-file-pick">
          <span className="exam-file-pick-label">＋ 파일 선택{files.length ? ` (${files.length})` : ''}</span>
          <input
            type="file" multiple
            accept=".pdf,.ppt,.pptx,.hwp,.docx,.zip,.jpg,.png"
            onChange={(e) => { pickFiles(e.target.files); e.target.value = ''; }}
          />
        </label>
        {files.length > 0 && (
          <ul className="exam-file-chips">
            {files.map((f, i) => (
              <li key={`${f.name}:${f.size}:${i}`} className="exam-file-chip">
                <span className="exam-file-chip-name">{f.name}</span>
                <button type="button" className="exam-file-chip-x" aria-label="제거" onClick={() => removeFile(i)}>×</button>
              </li>
            ))}
          </ul>
        )}
        <span className="account-note exam-file-note">용량이 크면 PDF 압축 후 올려주세요(스캔본은 화질만 유지되게).</span>
        <span className="account-note exam-file-note">업로드 후 {EXAM_RETENTION_YEARS}년간 보관되며, 이후 자동 삭제됩니다.</span>
      </div>

      <DeletePasswordField value={password} onChange={setPassword} />

      {error && <p className="error-msg">{error}</p>}

      <button type="submit" className="btn-add btn-block" disabled={submitting}>
        {submitting ? '업로드 중…' : '족보 올리기'}
      </button>
    </form>
  );
}
