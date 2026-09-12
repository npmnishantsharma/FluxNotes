'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { ChatGptMark, GeminiMark } from '@/components/icons/ProviderIcons';
import { WindowControls } from '@/components/ui/WindowControls';
import { AIProvider, ExportFormat } from '@/types/notes';

type ChatTitleBarProps = {
  pageTitle: string;
  provider: AIProvider;
  isProductionBuild: boolean;
  hasStartedGeneration: boolean;
  hasPageImages: boolean;
  exportFormat: ExportFormat;
  isExporting: boolean;
  onChangeProvider: (provider: AIProvider) => void;
  onChangeExportFormat: (format: ExportFormat) => void;
  onExportNotes: () => void;
};

export function ChatTitleBar({
  pageTitle,
  provider,
  isProductionBuild,
  hasStartedGeneration,
  hasPageImages,
  exportFormat,
  isExporting,
  onChangeProvider,
  onChangeExportFormat,
  onExportNotes,
}: ChatTitleBarProps) {
  const router = useRouter();

  return (
    <div
      className="z-50 flex h-9 w-full shrink-0 select-none items-center justify-between border-b border-white/5 bg-black px-3 text-xs text-[#a1a1aa] backdrop-blur-md"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-2 font-medium text-white" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          onClick={() => router.push('/')}
          className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-slate-300 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-400"
          aria-label="Back to dashboard"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          <span>Back</span>
        </button>
        <span className="font-normal text-slate-400">/</span>
        <span className="font-semibold text-slate-200">{pageTitle}</span>
        <div className="ml-2 flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 p-0.5" aria-label="AI provider">
          <button
            type="button"
            onClick={() => onChangeProvider('chatgpt')}
            aria-label="Use ChatGPT"
            title="Use ChatGPT"
            aria-pressed={provider === 'chatgpt'}
            className={`flex h-7 w-7 items-center justify-center rounded-md transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-400 ${
              provider === 'chatgpt' ? 'bg-teal-300/20 text-teal-200' : 'text-slate-500 hover:text-white'
            }`}
          >
            <ChatGptMark />
          </button>
          {!isProductionBuild && (
            <>
              <button
                type="button"
                onClick={() => onChangeProvider('gemini')}
                aria-label="Use Gemini"
                title="Use Gemini"
                aria-pressed={provider === 'gemini'}
                className={`flex h-7 w-7 items-center justify-center rounded-md transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-400 ${
                  provider === 'gemini' ? 'bg-blue-400/20 text-blue-200' : 'text-slate-500 hover:text-white'
                }`}
              >
                <GeminiMark />
              </button>
              <span className="mr-1 text-[8px] font-semibold tracking-wide text-blue-300/80">DEV</span>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {hasStartedGeneration && hasPageImages && (
          <>
            <select
              value={exportFormat}
              onChange={(event) => onChangeExportFormat(event.target.value as ExportFormat)}
              disabled={isExporting}
              aria-label="Export format"
              className="h-7 rounded border border-white/10 bg-white/5 px-1.5 text-[11px] text-slate-300 outline-none hover:bg-white/10 disabled:opacity-50"
            >
              <option value="pdf">PDF</option>
              <option value="png">PNG</option>
              <option value="jpeg">JPEG</option>
              <option value="md">Markdown (.md)</option>
            </select>
            <button
              onClick={onExportNotes}
              disabled={isExporting}
              className="flex h-7 items-center gap-1 rounded border border-teal-500/30 bg-teal-500/10 px-2 text-[11px] text-teal-200 transition hover:bg-teal-500/20 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-400"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />
              </svg>
              <span>{isExporting ? 'Exporting…' : 'Export'}</span>
            </button>
            <span className="mx-1 h-5 w-px bg-white/10" />
          </>
        )}
        <WindowControls />
      </div>
    </div>
  );
}
