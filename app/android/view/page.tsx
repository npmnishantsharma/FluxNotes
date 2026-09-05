'use client';

/* eslint-disable @next/next/no-img-element */
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getMobileDeviceInfo, getMobileValue, mobileKeys, setMobileValue } from '../mobile-storage';

type NoteItem = {
  topicId: string;
  topicName: string;
  images?: string[];
  subTopics?: { names: string[]; pageNumber: string | number }[];
  timestamp?: number;
  pinned?: boolean;
};

function imageSource(imagePath: string, hostUrl: string): string {
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://') || imagePath.startsWith('data:')) return imagePath;
  const host = hostUrl.replace(/^wss?:\/\//, (scheme) => scheme === 'wss://' ? 'https://' : 'http://').replace(/\/ws\/?$/, '');
  return `${host}${imagePath.startsWith('/') ? imagePath : `/${imagePath}`}`;
}

export default function AndroidNoteViewPage() {
  const router = useRouter();
  const [note, setNote] = useState<NoteItem | null>(null);
  const [status, setStatus] = useState('Loading note');
  const [error, setError] = useState('');
  const [hostUrl, setHostUrl] = useState('');

  useEffect(() => {
    let socket: WebSocket | null = null;
    let timeout: number | undefined;
    const loadNote = async () => {
      const requestedId = new URLSearchParams(window.location.search).get('id');
      const [configuredHost, authToken] = await Promise.all([
        getMobileValue(mobileKeys.hostUrl),
        getMobileValue(mobileKeys.hostToken),
      ]);
      setHostUrl(configuredHost);
      if (!requestedId) {
        setError('No note was selected.');
        setStatus('');
        return;
      }
      if (!configuredHost || !authToken) {
        setError('Configure the host connection first.');
        setStatus('');
        return;
      }

      socket = new WebSocket(configuredHost);
      timeout = window.setTimeout(() => {
        socket?.close();
        setError('The host took too long to respond.');
        setStatus('');
      }, 15000);

      socket.onopen = () => {
        setStatus('Authenticating');
        getMobileDeviceInfo().then((deviceInfo) => {
          socket?.send(JSON.stringify({ type: 'auth', authToken, deviceInfo }));
        }).catch(() => {
          setError('Unable to read device information.');
          setStatus('');
          socket?.close();
        });
      };
      socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as Record<string, unknown>;
      if (message.type === 'authenticated') {
        void setMobileValue(mobileKeys.sessionId, String(message.sessionId || ''));
        void setMobileValue(mobileKeys.sessionToken, String(message.token || ''));
        void setMobileValue(mobileKeys.renewToken, String(message.renewToken || ''));
        setStatus('Loading note');
        socket?.send(JSON.stringify({ type: 'list_notes', sessionId: message.sessionId, token: message.token }));
        return;
      }
      if (message.type === 'notes') {
        const selectedNote = (Array.isArray(message.notes) ? message.notes : [])
          .find((candidate) => (candidate as NoteItem).topicId === requestedId) as NoteItem | undefined;
        if (!selectedNote) setError('This note is no longer available.');
        else {
          setNote(selectedNote);
          setStatus('');
        }
        window.clearTimeout(timeout);
        socket?.close();
        return;
      }
      if (message.type === 'error') {
        window.clearTimeout(timeout);
        setError(String(message.message || 'Unable to load this note.'));
        setStatus('');
        socket?.close();
      }
    };
      socket.onerror = () => {
      window.clearTimeout(timeout);
      setError('Unable to reach the host.');
      setStatus('');
    };

      if (timeout) window.clearTimeout(timeout);
    };
    void loadNote();
    return () => {
      if (timeout) window.clearTimeout(timeout);
      socket?.close();
    };
  }, []);

  return (
    <main className="min-h-dvh bg-[#091012] text-slate-100">
      <div className="mx-auto min-h-dvh w-full max-w-lg px-5 pb-10 pt-6">
        <header className="flex items-center gap-4">
          <button type="button" onClick={() => router.push('/android/dashboard')} aria-label="Back to dashboard" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.05] text-xl text-slate-300 active:scale-95">&#8592;</button>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-teal-300">FluxNotes Mobile</p>
            <h1 className="mt-1 truncate text-xl font-semibold text-white">{note?.topicName || 'Note viewer'}</h1>
          </div>
        </header>

        {status && <div className="mt-8 rounded-3xl border border-white/10 bg-white/[0.04] p-5 text-sm text-slate-500">{status}</div>}
        {error && (
          <section className="mt-8 rounded-3xl border border-rose-300/15 bg-rose-300/[0.06] p-5">
            <p className="text-sm text-rose-200">{error}</p>
            <button type="button" onClick={() => router.push('/android/settings')} className="mt-4 rounded-xl bg-rose-200 px-4 py-2 text-xs font-semibold text-[#281116]">Open connection settings</button>
          </section>
        )}

        {note && (
          <>
            <section className="mt-7 rounded-3xl border border-white/10 bg-[#111a1c] p-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.16em] text-teal-300/80">{note.images?.length || 0} pages</p>
                  <h2 className="mt-2 text-2xl font-semibold leading-tight text-white">{note.topicName || 'Untitled Topic'}</h2>
                </div>
                {note.pinned && <span className="rounded-full bg-amber-300/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-300">Pinned</span>}
              </div>
              <p className="mt-3 text-sm text-slate-500">{note.subTopics?.length || 0} subtopics · {formatDate(note.timestamp)}</p>
            </section>

            <section className="mt-5 space-y-4">
              {note.images?.map((image, index) => (
                <figure key={`${image}-${index}`} className="overflow-hidden rounded-3xl border border-white/10 bg-[#111a1c] shadow-2xl shadow-black/20">
                  <img src={imageSource(image, hostUrl)} alt={`Page ${index + 1} of ${note.topicName}`} className="block h-auto w-full" />
                  <figcaption className="px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-600">Page {index + 1}</figcaption>
                </figure>
              ))}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function formatDate(timestamp?: number): string {
  if (!timestamp) return 'New note';
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
