import { useState } from 'react';
import { supabase } from '../supabase';
import { uploadExamFile } from '../lib/storage';
import { maskProfanity } from '../lib/moderation';

const TYPES = ['중간고사', '기말고사', '퀴즈', '과제', '기타'];

// 족보 업로드 폼: 파일 → Storage 업로드 → create_exam(메타+key) RPC.
export default function ExamForm({ courseCode, onDone }) {
  const [title, setTitle] = useState('');
  const [examType, setExamType] = useState('중간고사');
  const [srcYear, setSrcYear] = useState('');
  const [srcTerm, setSrcTerm] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!title.trim()) return setError('제목을 입력하세요.');
    if (!file) return setError('파일을 선택하세요.');
    if (file.size > 20 * 1024 * 1024) return setError('파일은 20MB 이하여야 합니다.');
    if (password.length < 2) return setError('게시글 비밀번호를 입력하세요(삭제용).');

    setSubmitting(true);
    try {
      const key = await uploadExamFile(courseCode, file);
      const { error } = await supabase.rpc('create_exam', {
        p_post_password: password,
        p_course_code: courseCode,
        p_src_year: srcYear ? Number(srcYear) : null,
        p_src_term: srcTerm ? Number(srcTerm) : null,
        p_title: maskProfanity(title.trim()),
        p_exam_type: examType,
        p_file_url: key,
        p_description: maskProfanity(description.trim()) || null,
      });
      if (error) {
        setError(error.message || '등록에 실패했습니다.');
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
      <label className="rev-form-field">
        제목
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 2025-2 중간 정리" />
      </label>

      <div className="exam-row">
        <label className="rev-form-field">
          종류
          <select value={examType} onChange={(e) => setExamType(e.target.value)}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="rev-form-field">
          연도
          <input type="number" value={srcYear} onChange={(e) => setSrcYear(e.target.value)} placeholder="2025" />
        </label>
        <label className="rev-form-field">
          학기
          <select value={srcTerm} onChange={(e) => setSrcTerm(e.target.value)}>
            <option value="">-</option>
            <option value="1">1</option>
            <option value="2">2</option>
          </select>
        </label>
      </div>

      <label className="rev-form-field">
        설명
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="내용·출처 등(선택)" />
      </label>

      <label className="rev-form-field">
        파일 (20MB 이하)
        <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>

      <label className="rev-form-field">
        게시글 비밀번호
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="삭제용" />
      </label>

      {error && <p className="error-msg">{error}</p>}

      <button type="submit" className="btn-add" disabled={submitting}>
        {submitting ? '업로드 중…' : '족보 올리기'}
      </button>
    </form>
  );
}
