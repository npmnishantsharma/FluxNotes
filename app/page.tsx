'use client';

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { NoteItem, AIProvider } from '@/types/notes';
import { DashboardTitleBar } from '@/components/dashboard/DashboardTitleBar';
import { UpdateBanner } from '@/components/dashboard/UpdateBanner';
import { CreateNoteCard } from '@/components/dashboard/CreateNoteCard';
import { NoteCard } from '@/components/dashboard/NoteCard';

const PROVIDER_STORAGE_KEY = 'fluxnotes-ai-provider';

export default function DashboardPage() {
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [isCheckingOnboarding, setIsCheckingOnboarding] = useState(true);
  const [provider, setProvider] = useState<AIProvider>('chatgpt');

  // Auto-updater states
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'downloading' | 'ready'>('idle');
  const [downloadProgress, setDownloadProgress] = useState<number>(0);

  const router = useRouter();

  useEffect(() => {
    const savedProvider = window.localStorage.getItem(PROVIDER_STORAGE_KEY);
    if (savedProvider === 'chatgpt' || savedProvider === 'gemini') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProvider(savedProvider);
      setIsCheckingOnboarding(false);
      return;
    }

    router.replace('/onboarding');
  }, [router]);

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

  const openSettings = () => router.push('/settings');

  const changeProvider = (nextProvider: AIProvider) => {
    if (nextProvider === provider) return;
    window.localStorage.setItem(PROVIDER_STORAGE_KEY, nextProvider);
    setProvider(nextProvider);
  };

  if (isCheckingOnboarding) {
    return <div className="min-h-dvh bg-black" />;
  }

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
      <DashboardTitleBar
        provider={provider}
        onChangeProvider={changeProvider}
        updateStatus={updateStatus}
        downloadProgress={downloadProgress}
        onCheckForUpdates={checkForUpdates}
        onOpenSettings={openSettings}
      />

      {updateStatus === 'ready' && (
        <UpdateBanner onRestartAndInstall={() => window.electronAPI?.restartAndInstall()} />
      )}

      {/* Content Library */}
      <div className="custom-scrollbar flex-1 overflow-y-auto p-8">
        <div className="mx-auto max-w-6xl space-y-6">
          <div className="flex items-center justify-between border-b border-white/10 pb-4">
            <h1 className="text-xl font-bold tracking-wide text-slate-100">Your Notes Library</h1>
            <span className="font-mono text-xs text-slate-500">{notes.length} Notes Stored Locally</span>
          </div>

          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3">
            <CreateNoteCard onCreateNewNote={createNewNote} />

            {sortedNotes.map((note) => (
              <NoteCard
                key={note.topicId || note.timestamp}
                note={note}
                isOpenMenu={openMenuId === note.topicId}
                onOpenNote={openNote}
                onToggleMenu={(id) => setOpenMenuId((current) => current === id ? null : id)}
                onTogglePin={setPinned}
                onRename={renameNote}
                onDelete={deleteNote}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
