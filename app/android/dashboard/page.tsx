'use client';

/* eslint-disable @next/next/no-img-element */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getMobileValue, mobileKeys } from '../mobile-storage';
import { sendMobileCommand } from '../mobile-api';

type NoteItem = {
  topicId: string;
  topicName: string;
  images?: string[];
  subTopics?: { names: string[]; pageNumber: string | number }[];
  timestamp?: number;
  pinned?: boolean;
};

function toImageSource(imagePath: string, hostUrl: string): string {
  if (imagePath.startsWith('local://') || imagePath.startsWith('data:')) return imagePath;
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) return imagePath;
  const host = hostUrl.replace(/^wss?:\/\//, (scheme) => scheme === 'wss://' ? 'https://' : 'http://').replace(/\/ws\/?$/, '');
  return `${host}${imagePath.startsWith('/') ? imagePath : `/${imagePath}`}`;
}

export default function AndroidDashboardPage() {
  const router = useRouter();
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'home' | 'saved'>('home');
  const [connectionStatus, setConnectionStatus] = useState('Connecting');
  const [imageHostUrl, setImageHostUrl] = useState('');

  const loadNotes = useCallback(async () => {
    setIsLoading(true);
    const [hostUrl, authToken] = await Promise.all([
      getMobileValue(mobileKeys.hostUrl),
      getMobileValue(mobileKeys.hostToken),
    ]);
    setImageHostUrl(hostUrl);

    if (!hostUrl || !authToken) {
      setConnectionStatus('Host not configured');
      setNotes([]);
      setIsLoading(false);
      return;
    }

    setConnectionStatus('Connecting');
    try {
      setConnectionStatus('Loading notes');
      const response = await sendMobileCommand<{ notes?: unknown[] }>({ type: 'list_notes' });
      setNotes(Array.isArray(response.notes) ? response.notes as NoteItem[] : []);
      setConnectionStatus('Connected');
    } catch (error) {
      console.error('Failed to load notes from host:', error);
      setConnectionStatus(error instanceof Error ? error.message : 'Host unavailable');
      setNotes([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // The initial library fetch synchronizes state with Electron storage.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadNotes();
  }, [loadNotes]);

  const filteredNotes = useMemo(() => {
    const query = search.trim().toLowerCase();
    return [...notes]
      .filter((note) => activeTab === 'home' || note.pinned)
      .filter((note) => !query || note.topicName.toLowerCase().includes(query))
      .sort((first, second) => (
        Number(Boolean(second.pinned)) - Number(Boolean(first.pinned))
        || (second.timestamp || 0) - (first.timestamp || 0)
      ));
  }, [activeTab, notes, search]);

  const renameNote = async (note: NoteItem) => {
    const topicName = window.prompt('Enter a new note name:', note.topicName || 'Untitled Topic');
    if (!topicName?.trim()) return;
    await sendMobileCommand({ type: 'rename_note', topicId: note.topicId, topicName });
    await loadNotes();
  };

  const togglePinned = async (note: NoteItem) => {
    await sendMobileCommand({ type: 'set_note_pinned', topicId: note.topicId, pinned: !note.pinned });
    await loadNotes();
  };

  const deleteNote = async (note: NoteItem) => {
    if (!window.confirm(`Delete ${note.topicName || 'Untitled Topic'}?`)) return;
    await sendMobileCommand({ type: 'delete_note', topicId: note.topicId });
    await loadNotes();
  };

  const openNote = (topicId: string) => {
    router.push(`/android/view?id=${encodeURIComponent(topicId)}`);
  };

  const canCreateNote = connectionStatus === 'Connected';

  return (
    <main className="min-h-dvh bg-[#091012] text-slate-100">
      <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col px-5 pb-24 pt-7">
        <header className="flex items-center justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-teal-300">FluxNotes</p>
            <h1 className="mt-2 text-[29px] font-semibold tracking-[-0.04em] text-white">Your study desk</h1>
          </div>
          <button
            type="button"
            onClick={() => router.push('/android/settings')}
            aria-label="Open settings"
            className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.05] text-slate-300 transition active:scale-95"
          >
            <SettingsIcon />
          </button>
        </header>

        <section className="relative mt-7 overflow-hidden rounded-[28px] border border-teal-200/15 bg-[#123338] p-5 shadow-2xl shadow-teal-950/30">
          <div className="pointer-events-none absolute -right-8 -top-12 h-36 w-36 rounded-full border-[18px] border-teal-300/10" />
          <div className="relative">
            <p className="text-sm text-teal-100/70">A quieter way to learn</p>
            <h2 className="mt-2 max-w-[250px] text-2xl font-semibold leading-tight text-white">Turn one question into a visual note.</h2>
            <button
              type="button"
              onClick={() => canCreateNote && router.push('/chat')}
              disabled={!canCreateNote}
              className="mt-5 inline-flex h-11 items-center gap-2 rounded-2xl bg-teal-300 px-4 text-sm font-semibold text-[#092022] shadow-lg shadow-teal-950/30 transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              <PlusIcon />
              New note
            </button>
          </div>
        </section>

        <section className="mt-7 flex items-end justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">Library</p>
            <h2 className="mt-1 text-xl font-semibold text-white">Recent notes</h2>
          </div>
          <span className="rounded-full bg-white/[0.06] px-3 py-1 text-xs font-medium text-slate-400">{notes.length} total</span>
        </section>

        <p className={`mt-2 text-xs ${connectionStatus === 'Connected' ? 'text-teal-300' : 'text-slate-500'}`}>{connectionStatus}</p>

        <div className="mt-4 flex h-12 items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4">
          <SearchIcon />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search your notes"
            className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-slate-600"
          />
        </div>

        <div className="mt-5 flex gap-2">
          <button type="button" onClick={() => setActiveTab('home')} className={`rounded-full px-4 py-2 text-xs font-semibold transition ${activeTab === 'home' ? 'bg-teal-300 text-[#092022]' : 'bg-white/[0.06] text-slate-400'}`}>All notes</button>
          <button type="button" onClick={() => setActiveTab('saved')} className={`rounded-full px-4 py-2 text-xs font-semibold transition ${activeTab === 'saved' ? 'bg-teal-300 text-[#092022]' : 'bg-white/[0.06] text-slate-400'}`}>Pinned</button>
        </div>

        <section className="mt-4 space-y-3">
          {isLoading && <div className="rounded-3xl border border-white/10 bg-white/[0.035] p-5 text-sm text-slate-500">Loading your notes...</div>}
          {!isLoading && filteredNotes.length === 0 && (
            <div className="rounded-3xl border border-dashed border-white/15 bg-white/[0.025] px-5 py-10 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-300/10 text-teal-300"><BookIcon /></div>
              <h3 className="mt-4 font-semibold text-white">Nothing here yet</h3>
              <p className="mt-1 text-sm text-slate-500">Start a note and your library will appear here.</p>
            </div>
          )}
          {filteredNotes.map((note) => (
            <article key={note.topicId || note.timestamp} className="group flex gap-3 rounded-3xl border border-white/10 bg-[#111a1c] p-3 shadow-xl shadow-black/10">
              <button type="button" onClick={() => openNote(note.topicId)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                <div className="h-[72px] w-[72px] shrink-0 overflow-hidden rounded-2xl bg-[#20393b]">
                  {note.images?.[0]
                    ? <img src={toImageSource(note.images[0], imageHostUrl)} alt="" className="h-full w-full object-cover" />
                    : <div className="flex h-full items-center justify-center text-teal-200/70"><BookIcon /></div>}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-teal-300/80">
                    <span>{note.images?.length || 0} pages</span>
                    {note.pinned && <span className="text-amber-300">Pinned</span>}
                  </div>
                  <h3 className="mt-1 truncate text-[15px] font-semibold text-white">{note.topicName || 'Untitled Topic'}</h3>
                  <p className="mt-1 text-xs text-slate-500">{note.subTopics?.length || 0} subtopics · {formatDate(note.timestamp)}</p>
                </div>
              </button>
              <details className="relative shrink-0">
                <summary className="flex h-10 w-10 list-none items-center justify-center rounded-xl text-slate-500 transition marker:hidden active:bg-white/10"><MoreIcon /></summary>
                <div className="absolute right-0 top-11 z-10 w-36 rounded-2xl border border-white/10 bg-[#182325] p-1 shadow-2xl">
                  <button type="button" onClick={() => togglePinned(note)} className="w-full rounded-xl px-3 py-2.5 text-left text-xs text-slate-200 active:bg-white/10">{note.pinned ? 'Unpin' : 'Pin note'}</button>
                  <button type="button" onClick={() => renameNote(note)} className="w-full rounded-xl px-3 py-2.5 text-left text-xs text-slate-200 active:bg-white/10">Rename</button>
                  <button type="button" onClick={() => deleteNote(note)} className="w-full rounded-xl px-3 py-2.5 text-left text-xs text-rose-300 active:bg-rose-500/10">Delete</button>
                </div>
              </details>
            </article>
          ))}
        </section>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-20 mx-auto flex h-[76px] max-w-lg items-center justify-around border-t border-white/10 bg-[#091012]/95 px-8 backdrop-blur-xl">
        <button type="button" onClick={() => setActiveTab('home')} className={`flex flex-col items-center gap-1 text-[10px] font-semibold ${activeTab === 'home' ? 'text-teal-300' : 'text-slate-500'}`}><HomeIcon /><span>Home</span></button>
        <button type="button" onClick={() => canCreateNote && router.push('/chat')} disabled={!canCreateNote} className="flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-300 text-[#092022] shadow-lg shadow-teal-950/30 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none" aria-label="Create note"><PlusIcon /></button>
        <button type="button" onClick={() => router.push('/android/settings')} className="flex flex-col items-center gap-1 text-[10px] font-semibold text-slate-500"><SettingsIcon /><span>Settings</span></button>
      </nav>
    </main>
  );
}

function formatDate(timestamp?: number): string {
  if (!timestamp) return 'New note';
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function PlusIcon() {
  return <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14" /></svg>;
}

function SearchIcon() {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>;
}

function SettingsIcon() {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="m19.4 15 .1.1a2 2 0 1 1-2.8 2.8l-.1-.1a2 2 0 0 0-3.4 1.4V19a2 2 0 1 1-4 0v-.1a2 2 0 0 0-3.4-1.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A2 2 0 0 0 1.6 11H1.5a2 2 0 1 1 0-4h.1A2 2 0 0 0 3 3.6l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A2 2 0 0 0 9.2 1.5V1.4a2 2 0 1 1 4 0v.1a2 2 0 0 0 3.4 1.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A2 2 0 0 0 20.8 7h.1a2 2 0 1 1 0 4h-.1a2 2 0 0 0-1.4 3.4Z" /></svg>;
}

function HomeIcon() {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" /><path d="M9 21v-7h6v7" /></svg>;
}

function BookIcon() {
  return <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5v-16Z" /><path d="M4 5.5v16M8 7h8M8 11h8" /></svg>;
}

function MoreIcon() {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>;
}
