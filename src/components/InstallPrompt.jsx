import { useEffect, useState } from 'react';

// PWA 설치 프롬프트: beforeinstallprompt 를 잡아 "앱 설치" 배너를 띄운다.
export default function InstallPrompt() {
  const [deferred, setDeferred] = useState(null);
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem('installDismissed') === '1'
  );

  useEffect(() => {
    function onPrompt(e) {
      e.preventDefault();
      setDeferred(e);
    }
    function onInstalled() {
      setDeferred(null);
    }
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!deferred || dismissed) return null;

  async function install() {
    deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  }

  function close() {
    setDismissed(true);
    localStorage.setItem('installDismissed', '1');
  }

  return (
    <div className="install-banner">
      <span>애타를 홈 화면에 설치하면 앱처럼 쓸 수 있어요.</span>
      <span className="install-actions">
        <button className="install-yes" onClick={install}>설치</button>
        <button className="install-no" onClick={close}>✕</button>
      </span>
    </div>
  );
}
