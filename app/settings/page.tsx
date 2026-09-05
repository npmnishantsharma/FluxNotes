'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';

const PROVIDER_STORAGE_KEY = 'fluxnotes-ai-provider';
type SettingsSection = 'general' | 'provider' | 'ngrok' | 'appearance' | 'updates' | 'about';

type NgrokState = {
  configured: boolean;
  active: boolean;
  url: string | null;
  port: number;
  domain: string;
};

const sections: { id: SettingsSection; label: string; description: string }[] = [
  { id: 'general', label: 'General', description: 'App behavior and local data' },
  { id: 'provider', label: 'AI Provider', description: 'Choose your generation engine' },
  { id: 'ngrok', label: 'Ngrok Tunnel', description: 'Expose a local WebSocket service' },
  { id: 'appearance', label: 'Appearance', description: 'Theme and interface density' },
  { id: 'updates', label: 'Updates', description: 'Version and release settings' },
  { id: 'about', label: 'About FluxNotes', description: 'Version and project details' },
];

export default function SettingsPage() {
  const router = useRouter();
  const [activeSection, setActiveSection] = useState<SettingsSection>('ngrok');
  const [provider, setProvider] = useState<'chatgpt' | 'gemini'>('chatgpt');
  const [ngrokToken, setNgrokToken] = useState('');
  const [ngrokPort, setNgrokPort] = useState('8787');
  const [ngrokDomain, setNgrokDomain] = useState('');
  const [ngrokState, setNgrokState] = useState<NgrokState>({ configured: false, active: false, url: null, port: 8787, domain: '' });
  const [apiToken, setApiToken] = useState('');
  const [pairingQr, setPairingQr] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [updateMessage, setUpdateMessage] = useState('');

  useEffect(() => {
    const savedProvider = window.localStorage.getItem(PROVIDER_STORAGE_KEY);
    if (savedProvider === 'chatgpt' || savedProvider === 'gemini') {
      // Persisted provider selection is external state restored on mount.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProvider(savedProvider);
    }

    void window.electronAPI?.getApiToken().then(setApiToken);
    void window.electronAPI?.getNgrokSettings().then((settings) => {
      if (!settings) return;
      setNgrokState(settings);
      setNgrokPort(String(settings.port));
      setNgrokDomain(settings.domain);
    });
  }, []);

  const saveProvider = (nextProvider: 'chatgpt' | 'gemini') => {
    setProvider(nextProvider);
    window.localStorage.setItem(PROVIDER_STORAGE_KEY, nextProvider);
  };

  const saveNgrok = async () => {
    const port = Number(ngrokPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      window.alert('Enter a valid port between 1 and 65535.');
      return;
    }
    if (!ngrokToken.trim() && !ngrokState.configured) {
      window.alert('Enter an ngrok auth token first.');
      return;
    }

    setIsSaving(true);
    const result = await window.electronAPI?.configureNgrok(ngrokToken, port, ngrokDomain);
    setIsSaving(false);
    if (!result?.success) {
      window.alert(result?.error || 'Unable to configure ngrok.');
      return;
    }
    setNgrokState({
      configured: Boolean(result.configured),
      active: Boolean(result.active),
      url: result.url || null,
      port: result.port || port,
      domain: result.domain || ngrokDomain,
    });
    setNgrokToken('');
  };

  const disableNgrok = async () => {
    setIsSaving(true);
    const result = await window.electronAPI?.configureNgrok('', Number(ngrokPort), '');
    setIsSaving(false);
    if (!result?.success) {
      window.alert(result?.error || 'Unable to disable ngrok.');
      return;
    }
    setNgrokState({ configured: false, active: false, url: null, port: Number(ngrokPort), domain: '' });
    setNgrokToken('');
  };

  const checkForUpdates = async () => {
    setUpdateMessage('Checking for updates...');
    const result = await window.electronAPI?.checkForUpdates();
    if (result?.status === 'dev-mode') setUpdateMessage('Updates are disabled in development mode.');
    else if (result?.error) setUpdateMessage(result.error);
    else setUpdateMessage('You are running the latest available version.');
  };

  const websocketUrl = ngrokState.url
    ? `${ngrokState.url.replace(/^https?:\/\//, 'wss://').replace(/\/$/, '')}/ws`
    : null;

  useEffect(() => {
    if (!websocketUrl || !apiToken) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPairingQr('');
      return;
    }
    void QRCode.toDataURL(JSON.stringify({ host: websocketUrl, authToken: apiToken }), {
      width: 220,
      margin: 2,
      color: { dark: '#d5fff6', light: '#111a1c' },
    }).then(setPairingQr);
  }, [apiToken, websocketUrl]);

  const renderContent = () => {
    if (activeSection === 'general') {
      return (
        <SettingSection title="General" description="Control how FluxNotes behaves on this computer.">
          <SettingRow title="Launch at login" description="Start FluxNotes when you sign in to your computer."><Toggle /></SettingRow>
          <SettingRow title="Keep data local" description="Notes, generated pages, and settings stay on this device."><Toggle enabled /></SettingRow>
          <SettingRow title="Confirm before deleting" description="Ask before removing notes and their generated pages."><Toggle enabled /></SettingRow>
        </SettingSection>
      );
    }

    if (activeSection === 'provider') {
      return (
        <SettingSection title="AI Provider" description="Choose which assistant powers your note generation.">
          <div className="grid gap-3 sm:grid-cols-2">
            <ProviderCard name="ChatGPT" detail="Browser-assisted generation" active={provider === 'chatgpt'} onClick={() => saveProvider('chatgpt')} />
            <ProviderCard name="Gemini" detail="Available in development" active={provider === 'gemini'} onClick={() => saveProvider('gemini')} />
          </div>
        </SettingSection>
      );
    }

    if (activeSection === 'ngrok') {
      return (
        <SettingSection title="Ngrok Tunnel" description="Expose the local app or a WebSocket terminal through a secure public URL.">
          <div className="rounded-lg border border-white/10 bg-black/20 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-white">Tunnel status</div>
                <div className="mt-1 flex items-center gap-2 text-xs text-slate-400">
                  <span className={`h-2 w-2 rounded-full ${ngrokState.active ? 'bg-teal-400' : 'bg-slate-600'}`} />
                  {ngrokState.active ? 'Active' : ngrokState.configured ? 'Configured, inactive' : 'Not configured'}
                </div>
              </div>
              {websocketUrl && <span className="max-w-[48%] truncate font-mono text-xs text-teal-300" title={websocketUrl}>{websocketUrl}</span>}
            </div>
          </div>
          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <Field label="Mobile API token" hint="Use this token in the WebSocket auth message.">
              <input type="text" readOnly value={apiToken} className="settings-input font-mono" />
            </Field>
            <Field label="Auth token" hint={ngrokState.configured ? 'Leave blank to keep the saved token.' : undefined}>
              <input type="password" value={ngrokToken} onChange={(event) => setNgrokToken(event.target.value)} placeholder={ngrokState.configured ? 'Saved token' : 'Paste your ngrok token'} className="settings-input" />
            </Field>
            <Field label="Local port">
              <input type="number" min="1" max="65535" value={ngrokPort} onChange={(event) => setNgrokPort(event.target.value)} className="settings-input" />
            </Field>
            <Field label="Permanent domain" hint="Optional; leave blank for a dynamic URL.">
              <input type="text" value={ngrokDomain} onChange={(event) => setNgrokDomain(event.target.value)} placeholder="my-app.ngrok.app" className="settings-input" />
            </Field>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <button onClick={disableNgrok} disabled={isSaving || !ngrokState.configured} className="settings-danger disabled:opacity-40">Disable tunnel</button>
            <button onClick={saveNgrok} disabled={isSaving} className="settings-primary disabled:opacity-50">{isSaving ? 'Saving...' : 'Save and start tunnel'}</button>
          </div>
          <p className="mt-4 text-xs leading-5 text-slate-500">Mobile clients use the tunnel URL with <code className="text-slate-300">wss://</code> at <code className="text-slate-300">/ws</code>. The local API defaults to port <code className="text-slate-300">8787</code>.</p>
          {pairingQr && <div className="mt-5 flex items-center gap-4 rounded-lg border border-white/10 bg-black/20 p-3"><img src={pairingQr} alt="Mobile pairing QR code" className="h-28 w-28 rounded-md" /><div><div className="text-xs font-medium text-slate-200">Pair Android app</div><p className="mt-1 text-[10px] leading-4 text-slate-500">Scan this code from the first Android screen to import the host URL and auth token.</p></div></div>}
        </SettingSection>
      );
    }

    if (activeSection === 'appearance') {
      return (
        <SettingSection title="Appearance" description="Tune the interface for your preferred working rhythm.">
          <SettingRow title="Dark interface" description="Use the focused dark workspace throughout the app."><Toggle enabled /></SettingRow>
          <SettingRow title="Compact note cards" description="Fit more saved notes into the library view."><Toggle /></SettingRow>
        </SettingSection>
      );
    }

    if (activeSection === 'updates') {
      return (
        <SettingSection title="Updates" description="Keep FluxNotes current with the latest release.">
          <SettingRow title="Current version" description="FluxNotes 0.2.3"><span className="text-xs text-slate-400">Installed</span></SettingRow>
          <div className="pt-4"><button onClick={checkForUpdates} className="settings-primary">Check for updates</button>{updateMessage && <p className="mt-3 text-xs text-slate-400">{updateMessage}</p>}</div>
        </SettingSection>
      );
    }

    return (
      <SettingSection title="About FluxNotes" description="A quiet workspace for turning ideas into visual study notes.">
        <SettingRow title="Version" description="FluxNotes 0.2.3"><span className="font-mono text-xs text-slate-400">0.2.3</span></SettingRow>
        <SettingRow title="Storage" description="Your notes and generated pages are stored locally."><span className="text-xs text-teal-300">Local-first</span></SettingRow>
      </SettingSection>
    );
  };

  return (
    <div className="fixed inset-0 flex h-dvh flex-col overflow-hidden bg-[#090a0c] text-white">
      <div className="flex h-9 shrink-0 select-none items-center justify-between border-b border-white/10 bg-black px-3 text-xs text-slate-400" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button onClick={() => router.push('/')} aria-label="Back to notes" className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-white/10 hover:text-white"><span className="text-base">‹</span></button>
          <span className="font-semibold text-slate-200">FluxNotes</span>
          <span className="text-slate-600">/</span>
          <span>Settings</span>
        </div>
        <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button onClick={() => window.electronAPI?.minimize()} aria-label="Minimize" className="window-control"><span className="h-px w-2.5 bg-current" /></button>
          <button onClick={() => window.electronAPI?.maximize()} aria-label="Maximize" className="window-control"><span className="h-2.5 w-2.5 border border-current" /></button>
          <button onClick={() => window.electronAPI?.close()} aria-label="Close" className="window-control hover:bg-red-600"><span className="text-sm leading-none">×</span></button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="w-full shrink-0 border-b border-white/10 bg-[#0d0e11] p-3 md:w-72 md:border-b-0 md:border-r md:p-5">
          <div className="mb-4 px-2 pt-1"><div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-teal-300/80">Workspace</div><h1 className="mt-2 text-xl font-semibold tracking-tight text-white">Settings</h1></div>
          <nav className="flex gap-1 overflow-x-auto md:block md:space-y-1">
            {sections.map((section) => (
              <button key={section.id} onClick={() => setActiveSection(section.id)} className={`group flex min-w-max items-center gap-3 rounded-lg px-3 py-2.5 text-left transition md:w-full ${activeSection === section.id ? 'bg-teal-300/10 text-teal-200' : 'text-slate-400 hover:bg-white/5 hover:text-white'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${activeSection === section.id ? 'bg-teal-300' : 'bg-slate-700 group-hover:bg-slate-400'}`} />
                <span><span className="block text-xs font-medium">{section.label}</span><span className="mt-0.5 hidden text-[10px] text-slate-500 md:block">{section.description}</span></span>
              </button>
            ))}
          </nav>
        </aside>

        <main className="min-h-0 flex-1 overflow-y-auto p-5 md:p-10">
          <div className="mx-auto max-w-3xl">{renderContent()}</div>
        </main>
      </div>
    </div>
  );
}

function SettingSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <div><div className="border-b border-white/10 pb-6"><h2 className="text-2xl font-semibold tracking-tight text-white">{title}</h2><p className="mt-2 text-sm text-slate-400">{description}</p></div><div className="divide-y divide-white/10">{children}</div></div>;
}

function SettingRow({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-6 py-5"><div><div className="text-sm font-medium text-slate-200">{title}</div><div className="mt-1 text-xs text-slate-500">{description}</div></div><div className="shrink-0">{children}</div></div>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="block text-xs text-slate-300"><span>{label}</span>{hint && <span className="ml-2 text-[10px] text-slate-500">{hint}</span>}<span className="mt-2 block">{children}</span></label>;
}

function Toggle({ enabled = false }: { enabled?: boolean }) {
  return <span className={`flex h-6 w-10 items-center rounded-full p-1 ${enabled ? 'justify-end bg-teal-400' : 'bg-white/10'}`}><span className={`h-4 w-4 rounded-full ${enabled ? 'bg-black' : 'bg-slate-500'}`} /></span>;
}

function ProviderCard({ name, detail, active, onClick }: { name: string; detail: string; active: boolean; onClick: () => void }) {
  return <button onClick={onClick} className={`rounded-lg border p-4 text-left transition ${active ? 'border-teal-300/50 bg-teal-300/10' : 'border-white/10 bg-white/[0.02] hover:border-white/20'}`}><div className="flex items-center justify-between"><span className="text-sm font-medium text-white">{name}</span><span className={`h-2 w-2 rounded-full ${active ? 'bg-teal-300' : 'bg-slate-700'}`} /></div><p className="mt-2 text-xs text-slate-500">{detail}</p></button>;
}
