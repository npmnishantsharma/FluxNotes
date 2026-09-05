'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getMobileValue, mobileKeys, setMobileValue } from '../mobile-storage';

export default function AndroidSettingsPage() {
  const router = useRouter();
  const [hostUrl, setHostUrl] = useState('');
  const [hostToken, setHostToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void Promise.all([getMobileValue(mobileKeys.hostUrl), getMobileValue(mobileKeys.hostToken)])
      .then(([savedUrl, savedToken]) => {
        setHostUrl(savedUrl);
        setHostToken(savedToken);
      });
  }, []);

  const saveSettings = () => {
    const normalizedUrl = hostUrl.trim().replace(/\/$/, '');
    void setMobileValue(mobileKeys.hostUrl, normalizedUrl);
    void setMobileValue(mobileKeys.hostToken, hostToken.trim());
    setHostUrl(normalizedUrl);
    setHostToken(hostToken.trim());
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  };

  return (
    <main className="min-h-dvh bg-[#091012] text-slate-100">
      <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col px-5 pb-8 pt-7">
        <header className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => router.push('/android/dashboard')}
            aria-label="Back to dashboard"
            className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.05] text-xl text-slate-300 active:scale-95"
          >
            &#8592;
          </button>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-teal-300">FluxNotes Mobile</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-[-0.04em] text-white">Connection settings</h1>
          </div>
        </header>

        <section className="mt-8 rounded-[28px] border border-white/10 bg-[#111a1c] p-5 shadow-2xl shadow-black/20">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-teal-300/10 text-teal-300"><LinkIcon /></div>
            <div>
              <h2 className="font-semibold text-white">Host connection</h2>
              <p className="mt-1 text-sm leading-5 text-slate-500">Connect this mobile dashboard to your FluxNotes desktop host.</p>
            </div>
          </div>

          <div className="mt-7 space-y-5">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Host WebSocket URL</span>
              <input
                value={hostUrl}
                onChange={(event) => setHostUrl(event.target.value)}
                placeholder="wss://your-domain.ngrok.app/ws"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                className="mt-2 h-12 w-full rounded-2xl border border-white/10 bg-black/20 px-4 font-mono text-xs text-white outline-none transition placeholder:text-slate-700 focus:border-teal-300/60"
              />
              <span className="mt-2 block text-xs text-slate-600">Include the <code className="text-slate-400">/ws</code> path.</span>
            </label>

            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Host auth token</span>
              <div className="relative mt-2">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={hostToken}
                  onChange={(event) => setHostToken(event.target.value)}
                  placeholder="Paste the token from desktop Settings"
                  autoCapitalize="none"
                  autoCorrect="off"
                  className="h-12 w-full rounded-2xl border border-white/10 bg-black/20 px-4 pr-16 font-mono text-xs text-white outline-none transition placeholder:text-slate-700 focus:border-teal-300/60"
                />
                <button type="button" onClick={() => setShowToken((current) => !current)} className="absolute right-2 top-2 h-8 rounded-xl px-2 text-[10px] font-semibold text-teal-300 active:bg-white/10">{showToken ? 'Hide' : 'Show'}</button>
              </div>
            </label>
          </div>

          <button type="button" onClick={saveSettings} className="mt-7 flex h-12 w-full items-center justify-center rounded-2xl bg-teal-300 text-sm font-semibold text-[#092022] shadow-lg shadow-teal-950/30 active:scale-[0.98]">
            {saved ? 'Saved' : 'Save connection'}
          </button>
        </section>

        <p className="mt-5 px-2 text-center text-xs leading-5 text-slate-600">Your host details stay on this device. The token is sent only when opening the secure WebSocket connection.</p>
      </div>
    </main>
  );
}

function LinkIcon() {
  return <svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M10 13.5a4 4 0 0 0 5.7.2l2.8-2.8a4 4 0 0 0-5.7-5.7l-1.6 1.6" /><path d="M14 10.5a4 4 0 0 0-5.7-.2l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.6-1.6" /></svg>;
}
