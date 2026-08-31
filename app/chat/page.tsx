/* eslint-disable @next/next/no-img-element */
'use client';

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';

const isStartOrContinue = (text: string) => {
  const lower = text.trim().toLowerCase();
  return (
    lower.includes('start') ||
    lower.includes('continue') ||
    lower.includes('proceed') ||
    lower.includes('generate')
  );
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

type ExportFormat = 'pdf' | 'png' | 'jpeg';

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
  
  // Optimization: Pre-compute a map of page images for O(1) lookup during rendering
  const pageImagesMap = useMemo(() => {
    return new Map(pageImages.map(img => [img.pageNumber, img]));
  }, [pageImages]);

  const containerEndRef = useRef<HTMLDivElement | null>(null);
  const imageRefs = useRef<Record<number, HTMLImageElement | null>>({});
  const pageImagesRef = useRef<GeneratedPageImage[]>([]);
  const chatSessionRef = useRef<{ sessionId?: string; session?: AssistantData['chatSession']; chatUrl?: string }>({});

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
    const noteId = new URLSearchParams(window.location.search).get('id');
    if (!noteId) {
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

          const structuredPayload = JSON.stringify({
            status: currentStatus,
            subTopicNames: currentSubTopic.names || [],
            pageNumber: pageNumString
          }, null, 2);

          const responseData = await window.electronAPI?.fillChatGptInput(structuredPayload);
          if (!responseData || responseData === false || responseData.error) {
            throw new Error(`Could not generate page ${pageNumInt}.`);
          }
          if (responseData && typeof responseData === 'object') {
            chatSessionRef.current = {
              sessionId: responseData.chatSessionId || chatSessionRef.current.sessionId,
              session: responseData.chatSession || chatSessionRef.current.session,
              chatUrl: responseData.chatUrl || chatSessionRef.current.chatUrl,
            };
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
          <span className="text-slate-200 font-semibold">New Chat</span>
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
          <button onClick={minimizeWindow} className="flex h-9 w-11 items-center justify-center hover:bg-[#27272a] text-slate-400 hover:text-white transition"><svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor"><path d="M0 0h10v1H0z" /></svg></button>
          <button onClick={maximizeWindow} className="flex h-9 w-11 items-center justify-center hover:bg-[#27272a] text-slate-400 hover:text-white transition"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor"><rect x="0.5" y="0.5" width="9" height="9" /></svg></button>
          <button onClick={closeWindow} className="flex h-9 w-11 items-center justify-center hover:bg-red-600 text-slate-400 hover:text-white transition"><svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M1.07 0L0 1.07l3.93 3.93L0 8.93 1.07 10l3.93-3.93L8.93 10 10 8.93 6.07 5 10 1.07 8.93 0 5 3.93 1.07 0z" /></svg></button>
        </div>
      </div>

      <div className="relative flex flex-1 overflow-hidden bg-black">
        
        {/* Left/Center Area: PDF-Style Gallery View */}
        <div className="relative flex flex-1 flex-col overflow-y-auto pb-52 sm:pb-64 custom-scrollbar">
          <div className="mx-auto flex h-max w-full max-w-4xl flex-col gap-4 p-4">
            {hasStartedGeneration && assistantData?.subTopics && assistantData.subTopics.length > 0 ? (
              // Map through total expected pages based on subTopics outline
              assistantData.subTopics.map((subTopic, idx) => {
                const targetPageNum = Number(subTopic.pageNumber || idx + 1);
                const existingImage = pageImagesMap.get(targetPageNum);
                const isCurrentlyBuilding = currentlyGeneratingPage === targetPageNum;

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

                return (
                  <div 
                    key={`skeleton-page-${targetPageNum}`} 
                    className="w-full h-[600px] rounded-md bg-white/[0.03] animate-pulse border border-white/5 flex flex-col items-center justify-center gap-3 shadow-inner"
                  >
                    <div className="w-12 h-12 rounded-full border-2 border-teal-500/20 border-t-teal-400 animate-spin flex items-center justify-center text-xs text-teal-300 font-mono">
                    </div>
                    <span className="text-xs text-slate-400 tracking-wider font-medium">
                      {isCurrentlyBuilding 
                        ? `Generating page ${targetPageNum}...` 
                        : `Page ${targetPageNum} waiting in queue...`}
                    </span>
                  </div>
                );
              })
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
