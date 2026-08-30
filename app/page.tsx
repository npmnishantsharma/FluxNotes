/* eslint-disable @next/next/no-img-element */
'use client';

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';

type SubTopic = {
  names: string[];
  pageNumber: string | number;
};

type NoteItem = {
  topicId: string;
  topicName: string;
  chatUrl: string;
  images: string[];
  subTopics: SubTopic[];
  timestamp: number;
  pinned?: boolean;
};

const toImageSource = (imagePath: string) => (
  imagePath.startsWith('local://') ? imagePath : `local://${encodeURI(imagePath.replace(/\\/g, '/'))}`
);

export default function DashboardPage() {
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  
  // Auto-updater states
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'downloading' | 'ready'>('idle');
  const [downloadProgress, setDownloadProgress] = useState<number>(0);

  const router = useRouter();

  const sortedNotes = useMemo(() => {
    return [...notes].sort((first, second) => (
      Number(Boolean(second.pinned)) - Number(Boolean(first.pinned)) || second.timestamp - first.timestamp
    ));
  }, [notes]);

  const loadNotes = useCallback(async () => {
    if (window.electronAPI?.getAllNotes) {
      try {
        const savedNotes = await window.electronAPI.getAllNotes();
        if (savedNotes) {
          setNotes(savedNotes);
        }
      } catch (err) {
        console.error("Failed to load notes library:", err);
      }
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadNotes();

    // Listen to updater events pushed from electron/main.js
    if (window.electronAPI?.onUpdaterEvent) {
      window.electronAPI.onUpdaterEvent((data) => {
        if (data.type === 'update-available') {
          setUpdateStatus('downloading');
        } else if (data.type === 'download-progress') {
          setDownloadProgress(Math.round(data.progress || 0));
        } else if (data.type === 'update-downloaded') {
          setUpdateStatus('ready');
        }
      });
    }
  }, [loadNotes]);

  const checkForUpdates = async () => {
    if (window.electronAPI?.checkForUpdates) {
      setUpdateStatus('checking');
      const res = await window.electronAPI.checkForUpdates();
      if (res?.status === 'dev-mode') {
        window.alert('Updates are disabled in development mode.');
        setUpdateStatus('idle');
      } else if (res?.error) {
        window.alert(`Update check failed: ${res.error}`);
        setUpdateStatus('idle');
      } else {
        // If no immediate event triggers, reset back if it finds nothing
        setTimeout(() => {
          if (updateStatus === 'checking') setUpdateStatus('idle');
        }, 4000);
      }
    }
  };

  const openNote = (topicId: string) => {
    router.push(`/chat?id=${encodeURIComponent(topicId)}`);
  };

  const createNewNote = () => {
    router.push('/chat');
  };

  const minimizeWindow = () => window.electronAPI?.minimize();
  const maximizeWindow = () => window.electronAPI?.maximize();
  const closeWindow = () => window.electronAPI?.close();

  const renameNote = async (note: NoteItem) => {
    const topicName = window.prompt('Enter a new note name:', note.topicName || 'Untitled Topic');
    if (topicName === null || !topicName.trim()) return;

    const result = await window.electronAPI?.renameNote(note.topicId, topicName);
    if (!result?.success) window.alert(result?.error || 'Unable to rename the note.');
    setOpenMenuId(null);
    await loadNotes();
  };

  const setPinned = async (note: NoteItem) => {
    const result = await window.electronAPI?.setNotePinned(note.topicId, !note.pinned);
    if (!result?.success) window.alert(result?.error || 'Unable to update the note.');
    setOpenMenuId(null);
    await loadNotes();
  };

  const deleteNote = async (note: NoteItem) => {
    if (!window.confirm(`Delete “${note.topicName || 'Untitled Topic'}”? This also removes its saved pages.`)) return;

    const result = await window.electronAPI?.deleteNote(note.topicId);
    if (!result?.success) window.alert(result?.error || 'Unable to delete the note.');
    setOpenMenuId(null);
    await loadNotes();
  };

  return (
    <div className="fixed inset-0 flex h-dvh flex-col overflow-hidden bg-black text-white">

      <div 
        className="flex h-9 w-full shrink-0 select-none items-center justify-between border-b border-none bg-black px-3 text-xs text-[#a1a1aa] backdrop-blur-md z-50"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-2 font-medium text-white" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <span className="text-slate-200 font-semibold pl-1">FluxNotes</span>
          
          {/* Updater status indicator / trigger button */}
          <button 
            onClick={checkForUpdates}
            className="ml-3 text-[10px] bg-white/5 hover:bg-white/10 border border-white/10 px-2 py-0.5 rounded text-slate-400 hover:text-white transition cursor-pointer"
            title="Click to check for updates manually"
          >
            {updateStatus === 'checking' && 'Checking updates...'}
            {updateStatus === 'downloading' && `Downloading (${downloadProgress}%)`}
            {updateStatus === 'ready' && 'Update Ready!'}
            {updateStatus === 'idle' && 'Check for updates'}
          </button>
        </div>

        <div className="flex items-center gap-1 -mr-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button onClick={minimizeWindow} aria-label="Minimize" title="Minimize" className="flex h-9 w-11 items-center justify-center hover:bg-[#27272a] focus-visible:bg-[#27272a] text-slate-400 hover:text-white focus-visible:text-white focus-visible:outline-none transition"><svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor"><path d="M0 0h10v1H0z" /></svg></button>
          <button onClick={maximizeWindow} aria-label="Maximize" title="Maximize" className="flex h-9 w-11 items-center justify-center hover:bg-[#27272a] focus-visible:bg-[#27272a] text-slate-400 hover:text-white focus-visible:text-white focus-visible:outline-none transition"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor"><rect x="0.5" y="0.5" width="9" height="9" /></svg></button>
          <button onClick={closeWindow} aria-label="Close" title="Close" className="flex h-9 w-11 items-center justify-center hover:bg-red-600 focus-visible:bg-red-600 text-slate-400 hover:text-white focus-visible:text-white focus-visible:outline-none transition"><svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M1.07 0L0 1.07l3.93 3.93L0 8.93 1.07 10l3.93-3.93L8.93 10 10 8.93 6.07 5 10 1.07 8.93 0 5 3.93 1.07 0z" /></svg></button>
        </div>
      </div>

      {/* Update Ready Banner Notification Overlay */}
      {updateStatus === 'ready' && (
        <div className="bg-teal-500/10 border-b border-teal-500/30 px-6 py-2.5 flex items-center justify-between text-xs z-40">
          <div className="flex items-center gap-2 text-teal-300 font-medium">
            <span className="h-2 w-2 rounded-full bg-teal-400 animate-ping" />
            A new version of FluxNotes has been downloaded from GitHub.
          </div>
          <button
            onClick={() => window.electronAPI?.restartAndInstall()}
            className="bg-teal-500 hover:bg-teal-400 text-black font-semibold px-3 py-1 rounded-md transition shadow-lg cursor-pointer"
          >
            Restart & Install Now
          </button>
        </div>
      )}

      {/* Content Library */}
      <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
        <div className="max-w-6xl mx-auto space-y-6">
          <div className="flex items-center justify-between border-b border-white/10 pb-4">
            <h1 className="text-xl font-bold tracking-wide text-slate-100">Your Notes Library</h1>
            <span className="text-xs text-slate-500 font-mono">{notes.length} Notes Stored Locally</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
            {/* Dashed Border Create New Note Card */}
            <div 
              onClick={createNewNote}
              className="group h-56 rounded-2xl border-2 border-dashed border-white/15 hover:border-teal-500/50 bg-[#111217]/30 hover:bg-[#111217]/70 backdrop-blur-xl flex flex-col items-center justify-center gap-3 cursor-pointer transition-all duration-300 shadow-xl"
            >
              <div className="w-12 h-12 rounded-full bg-white/5 group-hover:bg-teal-500/10 flex items-center justify-center text-slate-400 group-hover:text-teal-400 transition">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
              </div>
              <div className="text-center">
                <div className="text-sm font-medium text-slate-200 group-hover:text-teal-300 transition">Create New Note</div>
                <div className="text-xs text-slate-500 mt-0.5">Start a fresh AI study session</div>
              </div>
            </div>

            {/* Previously Made Notes Cards */}
            {sortedNotes.map((note) => (
              <div 
                key={note.topicId || note.timestamp}
                onClick={() => openNote(note.topicId)}
                className="group relative flex h-56 cursor-pointer flex-col justify-between overflow-hidden rounded-2xl border border-white/10 bg-[#111217] p-5 shadow-xl transition-all duration-300 hover:border-teal-500/40 hover:shadow-2xl"
              >
                {note.images?.[0] && (
                  <>
                    <img
                      src={toImageSource(note.images[0])}
                      alt=""
                      aria-hidden="true"
                      loading="lazy"
                      className="pointer-events-none absolute inset-0 h-full w-full scale-[1.03] object-cover opacity-45 blur-[1px] transition duration-300 group-hover:opacity-55"
                    />
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/15 via-[#111217]/30 to-[#111217]/60" />
                  </>
                )}
                <div className="relative z-10 space-y-2">
                  <div className="flex items-start justify-between">
                    <span className="text-[10px] font-mono bg-white/10 px-2 py-0.5 rounded text-slate-300 border border-white/5">
                      {note.images?.length || 0} Pages
                    </span>
                    <div className="flex items-center gap-1">
                      {note.pinned && <span className="text-[10px] text-teal-300">Pinned</span>}
                      <span className="text-[10px] font-medium text-slate-200 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">{new Date(note.timestamp).toLocaleDateString()}</span>
                      <button
                        onClick={(event) => { event.stopPropagation(); setOpenMenuId((current) => current === note.topicId ? null : note.topicId); }}
                        aria-label={`More options for ${note.topicName || 'note'}`}
                        className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-white/10 hover:text-white"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
                      </button>
                    </div>
                  </div>
                  <h3 className="text-sm font-semibold text-slate-200 group-hover:text-teal-300 transition line-clamp-2">
                    {note.topicName || "Untitled Topic"}
                  </h3>
                </div>

                <div className="relative z-10 space-y-2 border-t border-white/5 pt-3">
                  <div className="text-[11px] text-slate-400 line-clamp-1">
                    {note.subTopics?.length || 0} Subtopics outlined
                  </div>
                  {note.chatUrl && (
                    <div className="text-[9px] font-mono text-teal-400/70 truncate">
                      🔗 {note.chatUrl}
                    </div>
                  )}
                </div>
                {openMenuId === note.topicId && (
                  <div onClick={(event) => event.stopPropagation()} className="absolute right-4 top-12 z-10 w-36 rounded-lg border border-white/10 bg-[#17181f] p-1 shadow-2xl">
                    <button onClick={() => setPinned(note)} className="w-full rounded px-2.5 py-2 text-left text-xs text-slate-300 hover:bg-white/10">{note.pinned ? 'Unpin note' : 'Pin note'}</button>
                    <button onClick={() => renameNote(note)} className="w-full rounded px-2.5 py-2 text-left text-xs text-slate-300 hover:bg-white/10">Change name</button>
                    <button onClick={() => deleteNote(note)} className="w-full rounded px-2.5 py-2 text-left text-xs text-red-300 hover:bg-red-500/10">Delete note</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}