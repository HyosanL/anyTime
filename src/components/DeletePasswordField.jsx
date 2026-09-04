import { useState } from 'react';

// 익명 글의 '삭제용 비밀번호'는 대부분 안 쓴다 — 기본은 체크박스로 접어 두고,
// 켤 때만 입력창을 연다. value/onChange 로 상위 폼의 password 상태를 그대로 다룬다
// (체크 해제 시 '' 로 비운다).
export default function DeletePasswordField({
  value,
  onChange,
  hint = '설정하면 이 비밀번호로만 삭제할 수 있어요. 안 하면 누구나 삭제할 수 있어요.',
}) {
  const [open, setOpen] = useState(!!value);

  function toggle(e) {
    const next = e.target.checked;
    setOpen(next);
    if (!next && value) onChange('');
  }

  return (
    <div className="dpf">
      <label className="dpf-check">
        <input type="checkbox" checked={open} onChange={toggle} />
        삭제 비밀번호 설정
      </label>
      {open && (
        <>
          <input
            type="password"
            value={value}
            autoComplete="new-password"
            placeholder="삭제할 때 입력할 비밀번호"
            onChange={(e) => onChange(e.target.value)}
          />
          <p className="dpf-hint">{hint}</p>
        </>
      )}
    </div>
  );
}
