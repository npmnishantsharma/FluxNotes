/* eslint-disable @next/next/no-img-element */
'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ChatGptMark, GeminiMark } from '../onboarding/page';

const isStartOrContinue = (text: string) => {
  const lower = text.trim().toLowerCase();
  return (
    lower.includes('start') ||
    lower.includes('continue') ||
    lower.includes('proceed') ||
    lower.includes('generate')
  );
};

const COZY_GENERATION_STATUSES = [
  'Warming up the image engine…',
  'Sketching out your ideas gently…',
  'Mixing a fresh coat of colors…',
  'Crafting the layout on the canvas…',
  'Lettering handwritten headings…',
  'Laying down the base strokes…',
  'Composing a cozy hierarchy…',
  'Polishing the whitespace…',
  'Tidying up the margins…',
  'Tucking in the gradients…',
  'Placing the final decorations…',
  'Giving everything a last look…',
  'Warming the visual palette…',
  'Shaping the sections softly…',
  'Adding quiet highlights…',
  'Steaming the final image…',
] as const;

function formatElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

function TypingGenerationText({ active, pageNumber }: { active: boolean; pageNumber: number }) {
  const phrases = [
    `Sketching page ${pageNumber}...`,
    `Composing the layout...`,
    `Polishing the story...`,
    `Adding the final details...`,
  ];
  const [text, setText] = useState('');
  const [phraseIndex, setPhraseIndex] = useState(0);

  useEffect(() => {
    if (!active) {
      setText('');
      return;
    }

    const currentPhrase = phrases[phraseIndex % phrases.length];
    if (!currentPhrase) return;

    let index = 0;
    let timer: number | undefined;

    const tick = () => {
      index += 1;
      setText(currentPhrase.slice(0, index));
      if (index >= currentPhrase.length) {
        window.clearTimeout(timer);
        const next = window.setTimeout(() => {
          setPhraseIndex((prev) => prev + 1);
          setText('');
        }, 650);
        return () => window.clearTimeout(next);
      }
      timer = window.setTimeout(tick, 35);
    };

    tick();
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [active, phraseIndex]);

  return <span>{active ? text : 'Waiting for the next page...'}</span>;
}

function pickStatusForElapsed(ms: number, progress: string | null, fallbackIndex: number) {
  if (progress && progress.trim().length > 0) return progress;
  const bucket = Math.min(
    COZY_GENERATION_STATUSES.length - 1,
    Math.floor(fallbackIndex % COZY_GENERATION_STATUSES.length),
  );
  return COZY_GENERATION_STATUSES[bucket] ?? COZY_GENERATION_STATUSES[0];
};

type SubTopic = {
  names: string[];
  pageNumber: string | number;
};

type AssistantData = {
  status?: string;
  topicName?: string;
  topicId?: string;
  subTopics?: SubTopic[];
  aiResponse?: string;
  recommendedResponse?: string[];
  chatUrl?: string;
  chatSessionId?: string;
  chatSession?: { conversationId?: string | null; parentMessageId?: string | null } | null;
};

type GeneratedPageImage = {
  pageNumber: number;
  filePath: string;
};

function GeneratedImageCard({ image, innerRef }: { image: GeneratedPageImage; innerRef?: (element: HTMLImageElement | null) => void }) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div className="overflow-hidden rounded-md border border-white/5 shadow-lg">
      <img
        ref={innerRef}
        src={image.filePath}
        alt={`Generated Page ${image.pageNumber}`}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        className={[
          'block h-auto w-full transition-all duration-700 ease-out',
          loaded ? 'scale-100 opacity-100 blur-0' : 'scale-[1.02] opacity-0 blur-xl',
        ].join(' ')}
      />
    </div>
  );
}

type ExportFormat = 'pdf' | 'png' | 'jpeg';

const PROVIDER_STORAGE_KEY = 'fluxnotes-ai-provider';

export default function NewChatPage() {
  const router = useRouter();
  const [inputText, setInputText] = useState('');
  const [pageImages, setPageImages] = useState<GeneratedPageImage[]>([]);
  const [assistantData, setAssistantData] = useState<AssistantData | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [loadingPagesCount, setLoadingPagesCount] = useState<number>(0);
  const [generationProgress, setGenerationProgress] = useState<string | null>(null);
  const [currentlyGeneratingPage, setCurrentlyGeneratingPage] = useState<number | null>(null);
  const [hasStartedGeneration, setHasStartedGeneration] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('pdf');
  const [isExporting, setIsExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [pageStartTimes, setPageStartTimes] = useState<Record<number, number>>({});
  const [failedPages, setFailedPages] = useState<Record<number, string>>({});
  const [nowMs, setTickNow] = useState<number>(() => Date.now());
  const [provider, setProvider] = useState<'chatgpt' | 'gemini'>('chatgpt');
  const pageTitle = assistantData?.topicName?.trim() || 'New Chat';

  const containerEndRef = useRef<HTMLDivElement | null>(null);
  const imageRefs = useRef<Record<number, HTMLImageElement | null>>({});
  const pageImagesRef = useRef<GeneratedPageImage[]>([]);
  const chatSessionRef = useRef<{ sessionId?: string; session?: AssistantData['chatSession']; chatUrl?: string }>({});
  const startedNewChatRef = useRef(false);

  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);

  useEffect(() => {
    const savedProvider = window.localStorage.getItem(PROVIDER_STORAGE_KEY);
    if (savedProvider === 'chatgpt' || savedProvider === 'gemini') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProvider(savedProvider);
    }
  }, []);

  useEffect(() => {
    containerEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [pageImages, isProcessing, loadingPagesCount]);

  useEffect(() => {
    if (window.electronAPI?.onNewImage) {
      window.electronAPI.onNewImage((image) => {
        const filePath = typeof image === 'string' ? image : image.filePath;
        const pageNumber = typeof image === 'string' ? null : image.pageNumber;
        if (!filePath) return;
        setPageImages((prev) => {
          const nextPgNum = pageNumber || prev.length + 1;
          if (prev.some((item) => item.filePath === filePath)) return prev;
          
          setLoadingPagesCount((count) => Math.max(0, count - 1));
          setFailedPages((prevFailed) => {
            if (!prevFailed[nextPgNum]) return prevFailed;
            const next = { ...prevFailed };
            delete next[nextPgNum];
            return next;
          });
          const updatedImages = [...prev.filter((item) => item.pageNumber !== nextPgNum), { pageNumber: nextPgNum, filePath }]
            .sort((first, second) => first.pageNumber - second.pageNumber);
          pageImagesRef.current = updatedImages;
          return updatedImages;
        });
      });
    }

    if (window.electronAPI?.onProgressUpdate) {
      window.electronAPI.onProgressUpdate((progressVal: string) => {
        setGenerationProgress(progressVal);
      });
    }
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => setTickNow(Date.now()), 500);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const noteId = new URLSearchParams(window.location.search).get('id');
    if (!noteId) {
      if (startedNewChatRef.current) return;
      startedNewChatRef.current = true;
      void window.electronAPI?.startNewChat?.().then((chat) => {
        chatSessionRef.current = { sessionId: chat?.sessionId };
      });
      return;
    }
    if (!window.electronAPI?.getNoteById) return;

    let isCurrent = true;
    const loadSavedNote = async () => {
      try {
        const note = await window.electronAPI?.getNoteById(noteId);
        if (!isCurrent || !note) return;

        chatSessionRef.current = {
          sessionId: note.chatSessionId,
          session: note.chatSession,
          chatUrl: note.chatUrl,
        };
        await window.electronAPI?.setNoteChatSession?.({
          chatUrl: note.chatUrl,
          sessionId: note.chatSessionId,
          session: note.chatSession,
        });

        const savedImages = Array.isArray(note.images)
          ? note.images
            .filter((filePath: unknown): filePath is string => typeof filePath === 'string')
            .map((filePath: string, index: number) => ({
              pageNumber: index + 1,
              filePath: filePath.startsWith('local://')
                ? filePath
                : `local://${encodeURI(filePath.replace(/\\/g, '/'))}`,
            }))
          : [];

        pageImagesRef.current = savedImages;
        setPageImages(savedImages);
        setAssistantData({
          status: 'update',
          topicId: note.topicId,
          topicName: note.topicName,
          subTopics: Array.isArray(note.subTopics) ? note.subTopics : [],
          chatUrl: note.chatUrl,
          chatSessionId: note.chatSessionId,
          chatSession: note.chatSession,
        });
        setHasStartedGeneration(true);
      } catch (error) {
        console.error('Failed to load saved note:', error);
      }
    };

    void loadSavedNote();
    return () => { isCurrent = false; };
  }, []);

  const sendPrompt = useCallback(async (promptText: string) => {
    if (!promptText.trim() || isProcessing) return;

    setInputText('');
    setIsProcessing(true);
    setGenerationProgress("0%");
    
    setAssistantData((prev) => prev ? { ...prev, aiResponse: undefined, recommendedResponse: undefined } : null);

    try {
      const latestAssistantData = assistantData;

      if (isStartOrContinue(promptText) && assistantData?.subTopics && assistantData.subTopics.length > 0) {
        const subTopics = assistantData.subTopics;
        const totalPages = subTopics.length;

        setHasStartedGeneration(true);
        setPageImages([]);
        pageImagesRef.current = [];
        imageRefs.current = {};
        setPageStartTimes({});
        setFailedPages({});
        setAssistantData((prev) => prev ? {
          ...prev,
          aiResponse: undefined,
          recommendedResponse: undefined,
        } : null);
        setLoadingPagesCount(totalPages);

        for (let i = 0; i < totalPages; i++) {
          const currentSubTopic = subTopics[i];
          const pageNumInt = i + 1;
          const pageNumString = String(pageNumInt);
          const currentStatus = i === 0 ? 'start' : 'continue';

          setCurrentlyGeneratingPage(pageNumInt);
          setGenerationProgress("0%");
          setPageStartTimes((prev) => ({ ...prev, [pageNumInt]: Date.now() }));
          setFailedPages((prev) => {
            if (!prev[pageNumInt]) return prev;
            const next = { ...prev };
            delete next[pageNumInt];
            return next;
          });

          const structuredPayload = JSON.stringify({
            status: currentStatus,
            subTopicNames: currentSubTopic.names || [],
            pageNumber: pageNumString
          }, null, 2);

          try {
            const responseData = await window.electronAPI?.fillChatGptInput(structuredPayload);
            if (!responseData || responseData === false || (responseData as { error?: unknown })?.error) {
              throw new Error(`Could not generate page ${pageNumInt}.`);
            }
            if (responseData && typeof responseData === 'object') {
              chatSessionRef.current = {
                sessionId: responseData.chatSessionId || chatSessionRef.current.sessionId,
                session: responseData.chatSession || chatSessionRef.current.session,
                chatUrl: responseData.chatUrl || chatSessionRef.current.chatUrl,
              };
            }
          } catch (pageErr) {
            const errMsg = pageErr instanceof Error ? pageErr.message : `Generation failed for page ${pageNumInt}.`;
            console.error(errMsg, pageErr);
            setFailedPages((prev) => ({ ...prev, [pageNumInt]: errMsg }));
            setLoadingPagesCount((count) => Math.max(0, count - 1));
          }
        }

        setCurrentlyGeneratingPage(null);

        if (window.electronAPI?.saveNote && latestAssistantData) {
          const finalImagePaths = pageImagesRef.current.map((image) => image.filePath);
          await window.electronAPI.saveNote({
            topicId: latestAssistantData.topicId || String(Date.now()),
            topicName: latestAssistantData.topicName || "Untitled Notes",
            subTopics: latestAssistantData.subTopics || [],
            images: finalImagePaths,
            chatUrl: chatSessionRef.current.chatUrl,
            chatSessionId: chatSessionRef.current.sessionId,
            chatSession: chatSessionRef.current.session,
          });
        }

      } else {
        const responseData = await window.electronAPI?.fillChatGptInput(promptText);
        
        if (responseData && typeof responseData === 'object' && !responseData.error) {
          chatSessionRef.current = {
            sessionId: responseData.chatSessionId || chatSessionRef.current.sessionId,
            session: responseData.chatSession || chatSessionRef.current.session,
            chatUrl: responseData.chatUrl || chatSessionRef.current.chatUrl,
          };
          setAssistantData((prevData) => {
            const updated = responseData.status === 'update' && prevData ? {
              ...prevData,
              ...responseData,
              subTopics: responseData.subTopics || prevData.subTopics,
            } : responseData;
            return updated;
          });
        }
      }
    } catch (error) {
      console.error("Error during prompt execution flow:", error);
    } finally {
      setIsProcessing(false);
      setLoadingPagesCount(0);
      setGenerationProgress(null);
      setCurrentlyGeneratingPage(null);
    }
  }, [isProcessing, assistantData]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      sendPrompt(inputText);
    }
  };

  const handleSubTopicClick = (pageNumberStr: string | number) => {
    const pageNum = typeof pageNumberStr === 'string' ? parseInt(pageNumberStr, 10) : pageNumberStr;
    const targetImg = imageRefs.current[pageNum - 1];
    if (targetImg) {
      targetImg.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const minimizeWindow = () => window.electronAPI?.minimize();
  const maximizeWindow = () => window.electronAPI?.maximize();
  const closeWindow = () => window.electronAPI?.close();

  const changeProvider = (nextProvider: 'chatgpt' | 'gemini') => {
    if (nextProvider === provider) return;
    window.localStorage.setItem(PROVIDER_STORAGE_KEY, nextProvider);
    setProvider(nextProvider);
  };

  const exportNotes = async () => {
    if (isExporting || pageImages.length === 0 || !window.electronAPI?.exportNote) return;

    setIsExporting(true);
    setExportMessage(null);
    try {
      const result = await window.electronAPI.exportNote({
        images: pageImages.map((image) => image.filePath.replace(/^local:\/\//, '')),
        topicName: assistantData?.topicName || 'Notes',
        format: exportFormat,
      });
      if (result.success) {
        setExportMessage(`Exported ${result.count} page${result.count === 1 ? '' : 's'}.`);
      } else if (!result.canceled) {
        setExportMessage(result.error || 'Export failed.');
      }
    } catch (error) {
      console.error('Failed to export notes:', error);
      setExportMessage('Export failed.');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="fixed inset-0 flex h-dvh flex-col overflow-hidden bg-transparent text-white">
      {/* VS Code Style Custom Titlebar */}
      <div 
        className="flex h-9 w-full shrink-0 select-none items-center justify-between border-b border-white/5 bg-black px-3 text-xs text-[#a1a1aa] backdrop-blur-md z-50"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-2 font-medium text-white" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button 
            onClick={() => router.push('/')}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 hover:text-white transition cursor-pointer"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
            <span>Back</span>
          </button>
          <span className="text-slate-400 font-normal">/</span>
          <span className="text-slate-200 font-semibold">{pageTitle}</span>
          <div className="ml-2 flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 p-0.5" aria-label="AI provider">
            <button type="button" onClick={() => changeProvider('chatgpt')} aria-label="Use ChatGPT" aria-pressed={provider === 'chatgpt'} className={`flex h-7 w-7 items-center justify-center rounded-md transition ${provider === 'chatgpt' ? 'bg-teal-300/20 text-teal-200' : 'text-slate-500 hover:text-white'}`}>
              <ChatGptMark />
            </button>
            <button type="button" onClick={() => changeProvider('gemini')} aria-label="Use Gemini" aria-pressed={provider === 'gemini'} className={`flex h-7 w-7 items-center justify-center rounded-md transition ${provider === 'gemini' ? 'bg-blue-400/20 text-blue-200' : 'text-slate-500 hover:text-white'}`}>
              <GeminiMark />
            </button>
            <span className="mr-1 text-[8px] font-semibold tracking-wide text-blue-300/80">DEV</span>
          </div>
        </div>

        <div className="flex items-center gap-1 -mr-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {hasStartedGeneration && pageImages.length > 0 && (
            <>
              <select
                value={exportFormat}
                onChange={(event) => setExportFormat(event.target.value as ExportFormat)}
                disabled={isExporting}
                aria-label="Export format"
                className="h-7 rounded border border-white/10 bg-white/5 px-1.5 text-[11px] text-slate-300 outline-none hover:bg-white/10 disabled:opacity-50"
              >
                <option value="pdf">PDF</option>
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
              </select>
              <button
                onClick={exportNotes}
                disabled={isExporting}
                className="flex h-7 items-center gap-1 rounded border border-teal-500/30 bg-teal-500/10 px-2 text-[11px] text-teal-200 transition hover:bg-teal-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" /></svg>
                <span>{isExporting ? 'Exporting…' : 'Export'}</span>
              </button>
              <span className="mx-1 h-5 w-px bg-white/10" />
            </>
          )}
          <button onClick={minimizeWindow} aria-label="Minimize" title="Minimize" className="flex h-9 w-11 items-center justify-center hover:bg-[#27272a] focus-visible:bg-[#27272a] text-slate-400 hover:text-white focus-visible:text-white focus-visible:outline-none transition"><svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor"><path d="M0 0h10v1H0z" /></svg></button>
          <button onClick={maximizeWindow} aria-label="Maximize" title="Maximize" className="flex h-9 w-11 items-center justify-center hover:bg-[#27272a] focus-visible:bg-[#27272a] text-slate-400 hover:text-white focus-visible:text-white focus-visible:outline-none transition"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor"><rect x="0.5" y="0.5" width="9" height="9" /></svg></button>
          <button onClick={closeWindow} aria-label="Close" title="Close" className="flex h-9 w-11 items-center justify-center hover:bg-red-600 focus-visible:bg-red-600 text-slate-400 hover:text-white focus-visible:text-white focus-visible:outline-none transition"><svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M1.07 0L0 1.07l3.93 3.93L0 8.93 1.07 10l3.93-3.93L8.93 10 10 8.93 6.07 5 10 1.07 8.93 0 5 3.93 1.07 0z" /></svg></button>
        </div>
      </div>

      <div className="relative flex flex-1 overflow-hidden bg-black">
        
        {/* Left/Center Area: PDF-Style Gallery View */}
        <div className="relative flex flex-1 flex-col overflow-y-auto pb-52 sm:pb-64 custom-scrollbar">
          <div className="mx-auto flex h-max w-full max-w-4xl flex-col gap-4 p-4">
            {hasStartedGeneration && assistantData?.subTopics && assistantData.subTopics.length > 0 ? (
              <>
                <style>{`
                  @keyframes cozyGradientShift {
                    0%   { background-position: 0% 50%; }
                    40%  { background-position: 100% 50%; }
                    80%  { background-position: 60% 100%; }
                    100% { background-position: 0% 50%; }
                  }
                  @keyframes softBreathe {
                    0%, 100% { transform: scale(1); opacity: 0.65; }
                    50%      { transform: scale(1.04); opacity: 1; }
                  }
                  @keyframes sparkFloat {
                    0%   { transform: translate(-50%, 0) scale(1); opacity: 0.9; }
                    100% { transform: translate(-50%, -28px) scale(0.6); opacity: 0; }
                  }
                  @keyframes twinkle {
                    0%, 100% { opacity: 0.15; transform: scale(1); }
                    50%      { opacity: 0.9;  transform: scale(1.25); }
                  }
                  @keyframes failShake {
                    0%, 100% { transform: translateX(0); }
                    20% { transform: translateX(-4px); }
                    40% { transform: translateX(4px); }
                    60% { transform: translateX(-2px); }
                    80% { transform: translateX(2px); }
                  }
                  .cozy-bg {
                    background: linear-gradient(120deg, rgba(14,165,233,0.18), rgba(20,184,166,0.22), rgba(139,92,246,0.20), rgba(244,114,182,0.18));
                    background-size: 300% 300%;
                    animation: cozyGradientShift 9s ease-in-out infinite;
                  }
                  .cozy-breathe { animation: softBreathe 4.5s ease-in-out infinite; }
                  .cozy-spark { animation: sparkFloat 2.8s ease-out infinite; }
                  .cozy-twinkle { animation: twinkle 3s ease-in-out infinite; }
                  .fail-shake { animation: failShake 0.8s ease-in-out; }
                `}</style>
                {assistantData.subTopics.map((subTopic, idx) => {
                  const targetPageNum = Number(subTopic.pageNumber || idx + 1);
                  const existingImage = pageImages.find((p) => p.pageNumber === targetPageNum);
                  const isCurrentlyBuilding = currentlyGeneratingPage === targetPageNum;
                  const startTs = pageStartTimes[targetPageNum];
                  const elapsedMs = startTs ? nowMs - startTs : 0;
                  const failedMsg = failedPages[targetPageNum];
                  const statusBucket = Math.max(0, Math.floor((elapsedMs || 0) / 3500) + idx);
                  const displayStatus = failedMsg
                    ? 'Failed'
                    : pickStatusForElapsed(elapsedMs, isCurrentlyBuilding ? generationProgress : null, statusBucket);

                  if (existingImage) {
                    return (
                      <img
                        key={`page-${targetPageNum}`}
                        ref={(el) => { imageRefs.current[targetPageNum - 1] = el; }} 
                        src={existingImage.filePath} 
                        alt={`Generated Page ${targetPageNum}`} 
                        loading="lazy"
                        className="w-full h-auto block m-0 p-0 rounded-md border border-white/5 shadow-lg"
                      />
                    );
                  }

                  if (failedMsg) {
                    return (
                      <div
                        key={`skeleton-page-${targetPageNum}`}
                        className={`fail-shake relative w-full h-[600px] overflow-hidden rounded-md border border-red-500/40 bg-red-500/10 flex flex-col items-center justify-center gap-4 shadow-inner`}
                      >
                        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(239,68,68,0.18),transparent_60%)]" />
                        <div className="relative flex flex-col items-center gap-3 px-6 text-center">
                          <div className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-red-400/60 bg-red-500/20 text-red-200">
                            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M12 9v4" />
                              <path d="M12 17h.01" />
                              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                            </svg>
                          </div>
                          <div className="space-y-1">
                            <div className="text-sm font-semibold text-red-100">
                              Page {targetPageNum} failed to generate
                            </div>
                            <div className="max-w-md text-xs text-red-200/80">
                              {failedMsg}
                            </div>
                            <div className="pt-1 text-[11px] text-red-200/70">
                              Try regenerating this page again once the run finishes.
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  }

                  const statusForElapsed = displayStatus;

                  return (
                    <div 
                      key={`skeleton-page-${targetPageNum}`} 
                      className="relative w-full h-[600px] overflow-hidden rounded-md border border-white/10 flex flex-col shadow-inner isolate"
                    >
                      {/* Animated cozy background */}
                      <div className="cozy-bg absolute inset-0 opacity-90" aria-hidden />
                      <div
                        className="absolute inset-0 opacity-[0.35]"
                        aria-hidden
                        style={{
                          backgroundImage:
                            'radial-gradient(rgba(255,255,255,0.14) 1px, transparent 1px), radial-gradient(rgba(255,255,255,0.08) 1px, transparent 1px)',
                          backgroundSize: '22px 22px, 48px 48px',
                          backgroundPosition: '0 0, 11px 11px',
                          mixBlendMode: 'overlay',
                        }}
                      />
                      <div
                        className="absolute -left-16 top-10 h-48 w-48 rounded-full bg-cyan-300/30 blur-3xl cozy-twinkle"
                        style={{ animationDelay: `${(idx * 0.3) % 3}s` }}
                        aria-hidden
                      />
                      <div
                        className="absolute right-10 top-40 h-40 w-40 rounded-full bg-fuchsia-300/30 blur-3xl cozy-twinkle"
                        style={{ animationDelay: `${(0.7 + idx * 0.45) % 3}s` }}
                        aria-hidden
                      />
                      <div
                        className="absolute bottom-24 left-1/2 h-36 w-56 -translate-x-1/2 rounded-full bg-teal-300/30 blur-3xl cozy-twinkle"
                        style={{ animationDelay: `${(1.4 + idx * 0.6) % 3}s` }}
                        aria-hidden
                      />

                      {/* Content */}
                      <div className="relative z-10 flex h-full flex-col items-center justify-between px-8 py-8 text-center">
                        <div className="w-full flex items-start justify-between text-[11px] uppercase tracking-[0.22em] text-white/75">
                          <span className="rounded-full bg-black/30 px-3 py-1.5 backdrop-blur-sm border border-white/10">
                            Page {targetPageNum}
                          </span>
                          {isCurrentlyBuilding ? (
                            <span className="rounded-full bg-teal-500/30 px-3 py-1.5 text-teal-50 border border-teal-300/30 backdrop-blur-sm">
                              In progress
                            </span>
                          ) : (
                            <span className="rounded-full bg-white/10 px-3 py-1.5 text-white/80 border border-white/10 backdrop-blur-sm">
                              Queued
                            </span>
                          )}
                        </div>

                        <div className="flex flex-col items-center gap-6">
                          <div className="relative flex h-20 w-20 items-center justify-center">
                            <div className="absolute inset-0 rounded-full bg-white/20 cozy-breathe blur-xl" aria-hidden />
                            <div
                              className={`relative flex h-20 w-20 items-center justify-center rounded-full border-2 ${
                                isCurrentlyBuilding
                                  ? 'border-teal-200/60 bg-white/20 backdrop-blur-md'
                                  : 'border-white/30 bg-white/10 backdrop-blur-sm'
                              }`}
                            >
                              {isCurrentlyBuilding ? (
                                <>
                                  <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-teal-300 animate-spin" style={{ animationDuration: '1.1s' }} />
                                  <div className="absolute inset-1.5 rounded-full border border-transparent border-b-cyan-200/70 animate-spin" style={{ animationDuration: '1.8s', animationDirection: 'reverse' }} />
                                  <svg className="cozy-breathe" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M3 17l4.35-9.22a2 2 0 0 1 1.8-1.18h5.7a2 2 0 0 1 1.8 1.18L21 17" />
                                    <path d="M7.5 12.5a3 3 0 0 1 6 0" />
                                    <circle cx="8.5" cy="19" r="1" fill="white" />
                                    <circle cx="15.5" cy="19" r="1" fill="white" />
                                  </svg>
                                  <span className="absolute -top-2 left-1/2 -translate-x-1/2 h-2 w-2 rounded-full bg-fuchsia-300 cozy-spark" style={{ animationDelay: `${(idx * 0.6) % 3}s` }} />
                                  <span className="absolute -top-2 left-1/2 -translate-x-1/2 h-1.5 w-1.5 rounded-full bg-cyan-200 cozy-spark" style={{ animationDelay: `${(0.9 + idx * 0.7) % 3}s` }} />
                                </>
                              ) : (
                                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeOpacity="0.85" strokeWidth="1.8">
                                  <path d="M12 4v6m0 0-2.5-2M12 10l2.5-2M6.5 12H4M20 12h-2.5M6.8 18.2l-1.8 1.8M19 20l-1.8-1.8M6.8 5.8 5 4M19 4l-1.8 1.8" />
                                  <circle cx="12" cy="15" r="3.25" />
                                </svg>
                              )}
                            </div>
                          </div>

                          <div className="space-y-2.5">
                            <div className="text-base font-semibold text-white drop-shadow-sm">
                              {isCurrentlyBuilding ? (
                                <TypingGenerationText active={isCurrentlyBuilding} pageNumber={targetPageNum} />
                              ) : (
                                `Page ${targetPageNum} is ready to render`
                              )}
                            </div>
                            <div
                              className={`min-h-[22px] text-xs text-white/90 ${
                                isCurrentlyBuilding ? '' : 'opacity-80'
                              }`}
                            >
                              {isCurrentlyBuilding
                                ? 'Dressing the canvas with a fresh visual rhythm.'
                                : 'Everything is lined up and waiting for the next warm pass.'}
                            </div>
                            {subTopic?.names?.[0] && (
                              <div className="pt-1 text-[11px] text-white/70 line-clamp-1">
                                Theme — <span className="text-white/90">{subTopic.names[0]}</span>
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="w-full flex items-end justify-between text-[11px] text-white/80">
                          <div className="flex items-center gap-2 rounded-full bg-black/25 px-3 py-1.5 backdrop-blur-sm border border-white/10">
                            <span className="inline-block h-1.5 w-1.5 rounded-full bg-white/70 cozy-twinkle" />
                            <span className="tabular-nums font-mono tracking-wide">
                              {startTs ? formatElapsed(elapsedMs) : '—'}
                            </span>
                            <span className="text-white/60">elapsed</span>
                          </div>
                          <div className="text-right text-white/70">
                            {isCurrentlyBuilding
                              ? 'Hang tight — it takes time to look this cozy.'
                              : 'Your turn is coming up softly.'}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </>
            ) : hasStartedGeneration && pageImages.length > 0 ? (
              pageImages.map((img, idx) => (
                <img
                  key={idx}
                  ref={(el) => { imageRefs.current[idx] = el; }} 
                  src={img.filePath} 
                  alt={`Generated Page ${img.pageNumber}`} 
                  loading="lazy"
                  className="w-full h-auto block m-0 p-0 rounded-md border border-white/5 shadow-lg"
                />
              ))
            ) : (
              <div className="flex min-h-[50vh] items-center justify-center text-sm text-slate-500 text-center">
              </div>
            )}
            
            <div ref={containerEndRef} className="h-4" />
          </div>
        </div>

        {/* Right Sidebar */}
        {assistantData && (
          <aside className="w-64 sm:w-80 shrink-0 border-l border-white/5 bg-transparent flex flex-col overflow-hidden backdrop-blur-md">
            <div className="p-4 border-b border-white/5 flex items-center justify-between bg-black/20">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Notes Outline</h2>
              {assistantData.topicName && (
                <span className="text-[10px] bg-white/10 text-slate-300 px-2 py-0.5 rounded-full border border-white/5 truncate max-w-[120px]">
                  {assistantData.topicName}
                </span>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar text-xs">
              {assistantData.subTopics && assistantData.subTopics.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">Subtopics & Pages</div>
                  <div className="space-y-1.5">
                    {assistantData.subTopics.map((topic, index) => (
                      <button
                        key={index}
                        onClick={() => handleSubTopicClick(topic.pageNumber)}
                        className="w-full text-left p-2.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/5 transition flex items-center justify-between group"
                      >
                        <div className="space-y-1 pr-2">
                          {topic.names.map((name, i) => (
                            <div key={i} className="text-slate-300 group-hover:text-white transition line-clamp-1">
                              • {name}
                            </div>
                          ))}
                        </div>
                        <span className="shrink-0 text-[10px] font-mono bg-black/40 px-2 py-1 rounded text-slate-400 border border-white/5 shadow-inner">
                          Pg {topic.pageNumber}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="text-slate-500 text-center mt-10">No outline available yet.</div>
              )}
            </div>
          </aside>
        )}

        {/* Floating Input Box & Prompts */}
        <div className="absolute inset-x-0 bottom-0 z-10 flex flex-col items-center px-0 pb-4 sm:pb-6 lg:pb-10 pointer-events-none">
          
          <div className={`relative w-full px-3 sm:px-5 pointer-events-none flex flex-col gap-3 transition-all duration-300 ${assistantData ? 'pr-64 sm:pr-80' : ''}`}>
            
            {!hasStartedGeneration && assistantData?.aiResponse && (
              <div className="mx-auto w-full max-w-4xl bg-[#111217]/70 backdrop-blur-xl rounded-2xl px-6 py-4 text-sm text-slate-200 pointer-events-auto shadow-lg">
                {assistantData.aiResponse}
              </div>
            )}

            {!hasStartedGeneration && assistantData?.recommendedResponse && assistantData.recommendedResponse.length > 0 && (
              <div className="mx-auto w-full max-w-4xl flex flex-wrap justify-end gap-2 pointer-events-auto">
                {assistantData.recommendedResponse.map((rec, idx) => (
                  <button
                    key={idx}
                    onClick={() => sendPrompt(rec)}
                    disabled={isProcessing}
                    className="px-4 py-2 rounded-full bg-[#111217]/70 hover:bg-white/10 text-slate-300 text-xs transition backdrop-blur-xl cursor-pointer disabled:opacity-50 shadow-lg"
                  >
                    {rec}
                  </button>
                ))}
              </div>
            )}

            {/* Input Text Box */}
            <div className="relative mx-auto w-full max-w-4xl pointer-events-auto mt-1">
              <div className="absolute -inset-1 rounded-full bg-teal-500/15 blur-2xl transition-all duration-300 pointer-events-none" />
              <div className="absolute -inset-2 rounded-full bg-cyan-400/10 blur-[30px] transition-all duration-300 pointer-events-none" />
              
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isProcessing}
                placeholder={isProcessing ? `Responding ...` : "Type your prompt to generate your notes"}
                className="w-full relative rounded-full border border-teal-500/30 bg-[#111217]/80 backdrop-blur-xl px-6 py-4 text-sm text-white shadow-2xl transition placeholder-slate-400 focus:outline-none focus:border-cyan-400/50 disabled:opacity-90 disabled:cursor-not-allowed"
              />
              {exportMessage && (
                <p className="mt-2 text-center text-xs text-teal-300">{exportMessage}</p>
              )}
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
