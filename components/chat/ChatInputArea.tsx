/* eslint-disable @next/next/no-img-element */
'use client';

import React, { RefObject, useState, useEffect, useMemo } from 'react';
import { AssistantData, AIProvider } from '@/types/notes';
import { FileTypeIcon, formatFileSize, getFileKind } from './FileTypeIcon';

const TYPING_HINTS = [
  'Generate study notes on...',
  'Create detailed diagrams of...',
  'Explain the concept of...',
  'Summarize the key points of...',
  'Design visual aids for...',
  'Break down the topic of...',
];

type ChatInputAreaProps = {
  inputText: string;
  setInputText: (val: string) => void;
  isProcessing: boolean;
  hasStartedGeneration: boolean;
  assistantData: AssistantData | null;
  selectedFiles: ChatAttachment[];
  setSelectedFiles: React.Dispatch<React.SetStateAction<ChatAttachment[]>>;
  attachmentError: string | null;
  exportMessage: string | null;
  provider: AIProvider;
  promptInputRef: RefObject<HTMLTextAreaElement | null>;
  onSendPrompt: (promptText: string) => void;
  onFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onRemoveFile: (index: number) => void;
  selectedImagePageNumber: number | null;
  onDeselectImage: () => void;
};

export function ChatInputArea({
  inputText,
  setInputText,
  isProcessing,
  hasStartedGeneration,
  assistantData,
  selectedFiles,
  setSelectedFiles,
  attachmentError,
  exportMessage,
  provider,
  promptInputRef,
  onSendPrompt,
  onFileChange,
  onKeyDown,
  onRemoveFile,
  selectedImagePageNumber,
  onDeselectImage,
}: ChatInputAreaProps) {
  const [hintIndex, setHintIndex] = useState(0);
  
  // Calculate current typing hint based on conditions
  const typingHint = useMemo(() => {
    if (isProcessing || inputText) return '';
    const hasImageAttachment = selectedFiles.some(file => file.mimeType.startsWith('image/'));
    if (hasImageAttachment) return 'Describe changes to regenerate this page...';
    return TYPING_HINTS[hintIndex];
  }, [isProcessing, inputText, hintIndex, selectedFiles]);

  useEffect(() => {
    if (!isProcessing && !inputText) {
      const interval = setInterval(() => {
        setHintIndex((prev) => (prev + 1) % TYPING_HINTS.length);
      }, 3000);
      return () => clearInterval(interval);
    }
  }, [isProcessing, inputText]);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-center px-0 pb-4 sm:pb-6 lg:pb-10">
      <div className={`pointer-events-none relative flex w-full flex-col gap-3 px-3 transition-all duration-300 sm:px-5 ${assistantData ? 'pr-64 sm:pr-80' : ''}`}>
        {!hasStartedGeneration && assistantData?.aiResponse && (
          <div className="pointer-events-auto mx-auto w-full max-w-4xl rounded-2xl bg-[#111217]/70 px-6 py-4 text-sm text-slate-200 shadow-lg backdrop-blur-xl">
            {assistantData.aiResponse}
          </div>
        )}

        {!hasStartedGeneration && assistantData?.recommendedResponse && assistantData.recommendedResponse.length > 0 && (
          <div className="pointer-events-auto mx-auto flex w-full max-w-4xl flex-wrap justify-end gap-2">
            {assistantData.recommendedResponse.map((rec, idx) => (
              <button
                key={idx}
                onClick={() => onSendPrompt(rec)}
                disabled={isProcessing}
                className="cursor-pointer rounded-full bg-[#111217]/70 px-4 py-2 text-xs text-slate-300 shadow-lg backdrop-blur-xl transition hover:bg-white/10 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-400"
              >
                {rec}
              </button>
            ))}
          </div>
        )}

        {/* Input Text Box */}
        <div className="pointer-events-auto relative mx-auto mt-1 w-full max-w-4xl">
          {/* Bubble Dot Animation */}
          {isProcessing && (
            <div className="mb-3 flex justify-center">
              <div className="flex items-center gap-2">
                <div className="flex gap-1">
                  <div className="h-2 w-2 animate-bounce rounded-full bg-teal-400" style={{ animationDelay: '0ms' }} />
                  <div className="h-2 w-2 animate-bounce rounded-full bg-cyan-400" style={{ animationDelay: '150ms' }} />
                  <div className="h-2 w-2 animate-bounce rounded-full bg-teal-300" style={{ animationDelay: '300ms' }} />
                </div>
                <span className="text-xs text-teal-200 animate-pulse">Generating your notes...</span>
              </div>
            </div>
          )}
          
          <div className="pointer-events-none absolute -inset-1 rounded-full bg-teal-500/15 blur-2xl transition-all duration-300" />
          <div className="pointer-events-none absolute -inset-2 rounded-full bg-cyan-400/10 blur-[30px] transition-all duration-300" />

          {selectedImagePageNumber !== null && selectedFiles.some(file => file.mimeType.startsWith('image/')) && (
            <div className="mb-2 flex items-center gap-3 rounded-lg border border-teal-500/30 bg-[#111217]/90 px-3 py-2 shadow-lg">
              <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded border border-white/10">
                {(() => {
                  const imageFile = selectedFiles.find(file => file.mimeType.startsWith('image/'));
                  return imageFile ? (
                    <img 
                      src={`data:${imageFile.mimeType};base64,${imageFile.base64}`}
                      alt={`Page ${selectedImagePageNumber}`} 
                      className="h-full w-full object-cover"
                    />
                  ) : null;
                })()}
                <div className="absolute bottom-0 left-0 right-0 bg-teal-500/90 px-1 py-0.5 text-[9px] font-medium text-white text-center">
                  Page {selectedImagePageNumber}
                </div>
              </div>
              <div className="flex flex-1 flex-col">
                <span className="text-xs font-medium text-teal-200">
                  Selected for regeneration
                </span>
                <span className="text-[10px] text-slate-400">
                  Page {selectedImagePageNumber}
                </span>
              </div>
              <button
                type="button"
                onClick={onDeselectImage}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-black/70 text-xs text-white hover:bg-black/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-400"
                aria-label="Deselect image"
              >
                ×
              </button>
            </div>
          )}
          {selectedFiles.length > 0 && (
            <div className="mb-2 flex max-h-36 flex-wrap gap-2 overflow-y-auto rounded-lg border border-teal-500/30 bg-[#111217]/90 p-2 shadow-lg">
              {selectedFiles.map((file, index) => (
                <div key={`${file.filename}-${index}`} className="relative flex min-w-44 max-w-60 items-center gap-2 overflow-hidden rounded-md border border-white/10 bg-white/5 p-2" title={file.filename}>
                  {file.mimeType.startsWith('image/') ? (
                    <div className="relative h-10 w-10 shrink-0">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-teal-500/20">
                        <svg className="h-6 w-6 text-teal-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                      </div>
                      <span className="absolute bottom-0 left-0 right-0 rounded-b bg-teal-500/80 px-1 py-0.5 text-[9px] font-medium text-white text-center">
                        Regen
                      </span>
                    </div>
                  ) : (
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-black/20">
                      <FileTypeIcon kind={getFileKind(file.mimeType, file.filename)} />
                    </span>
                  )}
                  <span className="min-w-0 pr-4">
                    <span className="block truncate text-xs font-medium text-slate-200">{file.filename}</span>
                    <span className="block text-[10px] uppercase tracking-wide text-slate-500">
                      {getFileKind(file.mimeType, file.filename)} · {formatFileSize(file.fileSize)}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => onRemoveFile(index)}
                    className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-[11px] text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-400"
                    aria-label={`Remove ${file.filename}`}
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          )}
          {attachmentError && <p className="mb-2 text-center text-xs text-red-300">{attachmentError}</p>}
          <div className="relative flex items-end rounded-xl border border-teal-500/30 bg-[#111217]/80 pr-2 shadow-2xl backdrop-blur-xl focus-within:border-cyan-400/50 focus-within:shadow-[0_0_30px_rgba(45,212,191,0.3)] transition-all duration-300 focus-within:animate-gradient-glow">
            {provider === 'chatgpt' && (
              <>
                <input id="chat-attachment" type="file" multiple onChange={onFileChange} disabled={isProcessing || selectedFiles.length >= 10 || selectedFiles.some(file => file.mimeType.startsWith('image/'))} className="sr-only" />
                <label
                  htmlFor="chat-attachment"
                  title={selectedFiles.some(file => file.mimeType.startsWith('image/')) ? "Cannot attach files when image is selected for regeneration" : "Attach file"}
                  aria-label="Attach file"
                  className={`mb-2 ml-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-xl leading-none text-teal-200 transition ${selectedFiles.some(file => file.mimeType.startsWith('image/')) ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-white/10'}`}
                >
                  +
                </label>
              </>
            )}
            <textarea
              ref={promptInputRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              disabled={isProcessing}
              placeholder={isProcessing ? 'Responding ...' : typingHint || 'Type your prompt to generate your notes'}
              className="relative min-h-14 min-w-0 flex-1 resize-none rounded-xl bg-transparent px-4 py-4 text-sm leading-6 text-white outline-none placeholder-slate-400 disabled:cursor-not-allowed disabled:opacity-90"
            />
          </div>
          {exportMessage && (
            <p className="mt-2 text-center text-xs text-teal-300">{exportMessage}</p>
          )}
        </div>
      </div>
      
      {/* CSS Animations */}
      <style jsx>{`
        @keyframes gradient-border {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        
        .animate-gradient-border {
          animation: gradient-border 3s ease infinite;
        }
        
        @keyframes gradient-glow {
          0%, 100% { 
            box-shadow: 0 0 20px rgba(45, 212, 191, 0.3), 0 0 40px rgba(34, 211, 238, 0.2);
          }
          50% { 
            box-shadow: 0 0 30px rgba(45, 212, 191, 0.5), 0 0 60px rgba(34, 211, 238, 0.3);
          }
        }
        
        .animate-gradient-glow {
          animation: gradient-glow 3s ease infinite;
        }
      `}</style>
    </div>
  );
}
