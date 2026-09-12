/* eslint-disable @next/next/no-img-element */
'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { AssistantData, GeneratedPageImage, ExportFormat, AIProvider } from '@/types/notes';
import { ChatTitleBar } from '@/components/chat/ChatTitleBar';
import { PageSkeleton } from '@/components/chat/PageSkeleton';
import { ChatOutlineSidebar } from '@/components/chat/ChatOutlineSidebar';
import { ChatInputArea } from '@/components/chat/ChatInputArea';
import { NotesThemePreview } from '@/components/chat/NotesThemePreview';

const isStartOrContinue = (text: string) => {
  const lower = text.trim().toLowerCase();
  return (
    lower.includes('start') ||
    lower.includes('continue') ||
    lower.includes('proceed') ||
    lower.includes('generate')
  );
};

const PROVIDER_STORAGE_KEY = 'fluxnotes-ai-provider';
const isProductionBuild = process.env.NODE_ENV === 'production';

export default function NewChatPage() {
  const [inputText, setInputText] = useState('');
  const [pageImages, setPageImages] = useState<GeneratedPageImage[]>([]);
  const [assistantData, setAssistantData] = useState<AssistantData | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [loadingPagesCount, setLoadingPagesCount] = useState<number>(0);
  const [currentlyGeneratingPage, setCurrentlyGeneratingPage] = useState<number | null>(null);
  const [hasStartedGeneration, setHasStartedGeneration] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('pdf');
  const [isExporting, setIsExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [pageStartTimes, setPageStartTimes] = useState<Record<number, number>>({});
  const [failedPages, setFailedPages] = useState<Record<number, string>>({});
  const [failedPagesData, setFailedPagesData] = useState<Array<{pageNumber: number; subTopicNames: string[]; originalTopic: string; sessionId: string; errorMessage?: string; timestamp: number}>>([]);
  const [nowMs, setTickNow] = useState<number>(() => Date.now());
  const [provider, setProvider] = useState<AIProvider>('chatgpt');
  const [selectedFiles, setSelectedFiles] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [selectedImagePageNumber, setSelectedImagePageNumber] = useState<number | null>(null);
  const [noteTimestamp, setNoteTimestamp] = useState<number | null>(null);
  const [regeneratingPageNumber, setRegeneratingPageNumber] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<'image' | 'markdown'>('image');
  const [markdownCopied, setMarkdownCopied] = useState(false);
  const pageTitle = assistantData?.topicName?.trim() || 'New Chat';

  const generateMarkdownPreview = useCallback(() => {
    const title = assistantData?.topicName?.trim() || 'Untitled Notes';
    const subTopics = assistantData?.subTopics || [];
    let md = `# ${title}\n\n`;

    if (subTopics.length > 0) {
      md += `## Subtopics & Structure\n\n`;
      subTopics.forEach((st) => {
        const names = Array.isArray(st.names) ? st.names.join(', ') : String(st.names || '');
        md += `- **Page ${st.pageNumber}**: ${names}\n`;
      });
      md += `\n---\n\n`;
    }

    if (pageImages.length > 0) {
      md += `## Pages & Diagrams\n\n`;
      pageImages.forEach((img) => {
        const targetSubTopic = subTopics.find((st) => Number(st.pageNumber) === img.pageNumber);
        const name = targetSubTopic ? (Array.isArray(targetSubTopic.names) ? targetSubTopic.names.join(' - ') : String(targetSubTopic.names)) : `Page ${img.pageNumber}`;
        md += `### Page ${img.pageNumber}: ${name}\n\n`;
        md += `#### Note Page Image\n![Page ${img.pageNumber}](${img.filePath})\n\n`;
        md += `#### Visual Diagram Asset\n> **Diagram Schematic (Page ${img.pageNumber})**: Visual diagrams, flowcharts, and structural schematics.\n\n![Diagram Page ${img.pageNumber}](${img.filePath})\n\n`;
      });
    }

    if (assistantData?.aiResponse) {
      md += `## Summary & Notes\n\n${assistantData.aiResponse}\n`;
    }

    return md;
  }, [assistantData, pageImages]);

  const containerEndRef = useRef<HTMLDivElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const imageRefs = useRef<Record<number, HTMLImageElement | null>>({});
  const pageImagesRef = useRef<GeneratedPageImage[]>([]);
  const chatSessionRef = useRef<{ sessionId?: string; session?: AssistantData['chatSession']; chatUrl?: string }>({});
  const startedNewChatRef = useRef(false);

  useEffect(() => {
    const textarea = promptInputRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 180 ? 'auto' : 'hidden';
  }, [inputText]);

  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);

  useEffect(() => {
    const savedProvider = window.localStorage.getItem(PROVIDER_STORAGE_KEY);
    if (savedProvider === 'chatgpt' || (savedProvider === 'gemini' && !isProductionBuild)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProvider(savedProvider as AIProvider);
    }
  }, []);

  useEffect(() => {
    // Only scroll to bottom during processing or loading, not when images are added
    if (isProcessing || loadingPagesCount > 0) {
      containerEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [isProcessing, loadingPagesCount]);

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
          // Only remove failed status for the specific page that just succeeded
          setFailedPages((prevFailed) => {
            if (!prevFailed[nextPgNum]) return prevFailed;
            const next = { ...prevFailed };
            delete next[nextPgNum];
            return next;
          });
          const updatedImages = [...prev.filter((item) => item.pageNumber !== nextPgNum), { pageNumber: nextPgNum, filePath }]
            .sort((first, second) => first.pageNumber - second.pageNumber);
          pageImagesRef.current = updatedImages;

          // Clear regenerating state when new image arrives
          const wasRegenerating = regeneratingPageNumber === nextPgNum;
          if (wasRegenerating) {
            setRegeneratingPageNumber(null);
          }

          // Scroll to the newly added image
          setTimeout(() => {
            const targetImg = imageRefs.current[nextPgNum - 1];
            if (targetImg) {
              targetImg.scrollIntoView({ behavior: 'smooth', block: 'start' });
              
              // Add fade-in animation for regenerated images
              if (wasRegenerating) {
                targetImg.classList.add('fade-in-from-blur');
                setTimeout(() => {
                  targetImg.classList.remove('fade-in-from-blur');
                }, 1500);
              }
            }
          }, 100);

          return updatedImages;
        });
      });
    }

    // Listen for image generation failures from backend
    if (window.electronAPI?.onImageGenerationFailed) {
      window.electronAPI.onImageGenerationFailed((data: { pageNumber: number; errorMessage: string; subTopicNames: string[] }) => {
        console.log('[FRONTEND] Image generation failed for page:', data.pageNumber, data.errorMessage);
        setFailedPages((prev) => ({ ...prev, [data.pageNumber]: data.errorMessage }));
        setCurrentlyGeneratingPage(null);
        setLoadingPagesCount((count) => Math.max(0, count - 1));
      });
    }

    return () => {
      // Cleanup listeners if needed
    };
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => setTickNow(Date.now()), 500);
    return () => window.clearInterval(intervalId);
  }, []);

  // Load failed pages from storage on mount
  useEffect(() => {
    const loadFailedPages = async () => {
      try {
        const result = await window.electronAPI?.getFailedPages?.();
        if (result?.success && Array.isArray(result.failedPages)) {
          setFailedPagesData(result.failedPages);
        }
      } catch (error) {
        console.error('Failed to load failed pages:', error);
      }
    };
    loadFailedPages();
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
            .map((image: unknown, index: number) => {
              // Handle both old format (string) and new format (object with filePath and pageNumber)
              if (typeof image === 'string') {
                return {
                  pageNumber: index + 1, // Assign page number based on array index for old format
                  filePath: image.startsWith('local://')
                    ? image
                    : `local://${encodeURI(image.replace(/\\/g, '/'))}`,
                };
              } else if (image && typeof image === 'object' && 'filePath' in image) {
                const pageNumber = 'pageNumber' in image && typeof image.pageNumber === 'number' ? image.pageNumber : index + 1;
                return {
                  pageNumber,
                  filePath: typeof image.filePath === 'string' && image.filePath.startsWith('local://')
                    ? image.filePath
                    : `local://${encodeURI(String(image.filePath).replace(/\\/g, '/'))}`,
                };
              }
              return null;
            })
            .filter((image: unknown): image is { pageNumber: number; filePath: string } => 
              image !== null && 
              typeof image === 'object' && 
              'filePath' in image && 
              'pageNumber' in image
            )
          : [];

        pageImagesRef.current = savedImages;
        setPageImages(savedImages);
        setNoteTimestamp(note.timestamp || null);
        setAssistantData({
          status: 'update',
          topicId: note.topicId,
          topicName: note.topicName,
          subTopics: Array.isArray(note.subTopics) ? note.subTopics : [],
          chatUrl: note.chatUrl,
          chatSessionId: note.chatSessionId,
          chatSession: note.chatSession,
          notesTheme: note.notesTheme,
        });
        setHasStartedGeneration(true);
      } catch (error) {
        console.error('Failed to load saved note:', error);
      }
    };

    void loadSavedNote();
    return () => { isCurrent = false; };
  }, []);

  const sendPrompt = useCallback(async (promptText: string, attachments = selectedFiles) => {
    if (!promptText.trim() || isProcessing) return;

    setInputText('');
    setIsProcessing(true);

    setAssistantData((prev) => prev ? { ...prev, aiResponse: undefined, recommendedResponse: undefined, notesTheme: prev.notesTheme } : null);

    try {
      const latestAssistantData = assistantData;

      // Handle image regeneration case
      const isRegenerationMode = selectedImagePageNumber !== null;
      if (isRegenerationMode && latestAssistantData?.subTopics && latestAssistantData.subTopics.length > 0) {
        // Check if note was created before September 11, 2026
        const cutoffDate = new Date('2026-09-11').getTime();
        const isOldNote = noteTimestamp && noteTimestamp < cutoffDate;

        // Find the actual image file path from pageImages
        const targetPageNumber = selectedImagePageNumber ? String(selectedImagePageNumber) : "1";
        const targetImage = pageImages.find(img => img.pageNumber === selectedImagePageNumber);
        const imagePath = targetImage?.filePath.replace(/^local:\/\//, '') || '';

        // Get the subtopic for the specific page being regenerated
        const targetSubTopic = latestAssistantData.subTopics.find(
          subTopic => String(subTopic.pageNumber) === targetPageNumber
        );
        const subTopicNames = targetSubTopic?.names || [];

        // Set regenerating state for animation
        setRegeneratingPageNumber(selectedImagePageNumber);

        // Get the actual attachment with base64 data
        const imageAttachment = attachments.find(file => file.mimeType.startsWith('image/'));
        
        if (isOldNote) {
          // For old notes, send the edit directly as prompt and get the image to replace it
          const oldNotePayload = JSON.stringify({
            status: 'regenerate',
            subTopics: subTopicNames,
            pageNumber: targetPageNumber,
            edit: promptText,
            image: imagePath,
            isOldNote: true
          }, null, 2);

          // Send the actual attachment
          const responseData = await window.electronAPI?.fillChatGptInput(oldNotePayload, imageAttachment ? [imageAttachment] : null);
          
          if (responseData && typeof responseData === 'object') {
            chatSessionRef.current = {
              sessionId: responseData.chatSessionId || chatSessionRef.current.sessionId,
              session: responseData.chatSession || chatSessionRef.current.session,
              chatUrl: responseData.chatUrl || chatSessionRef.current.chatUrl,
            };
          }
        } else {
          // For new notes, use the standard regeneration payload
          const regeneratePayload = JSON.stringify({
            status: 'regenerate',
            subTopics: subTopicNames,
            pageNumber: targetPageNumber,
            edit: promptText,
            image: imagePath
          }, null, 2);

          // Send the actual attachment
          const responseData = await window.electronAPI?.fillChatGptInput(regeneratePayload, imageAttachment ? [imageAttachment] : null);
          
          if (responseData && typeof responseData === 'object') {
            chatSessionRef.current = {
              sessionId: responseData.chatSessionId || chatSessionRef.current.sessionId,
              session: responseData.chatSession || chatSessionRef.current.session,
              chatUrl: responseData.chatUrl || chatSessionRef.current.chatUrl,
            };
          }
        }
      } else if (isStartOrContinue(promptText) && assistantData?.subTopics && assistantData.subTopics.length > 0) {
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
          notesTheme: prev.notesTheme,
        } : null);
        setLoadingPagesCount(totalPages);

        for (let i = 0; i < totalPages; i++) {
          const currentSubTopic = subTopics[i];
          const pageNumInt = i + 1;
          const pageNumString = String(pageNumInt);
          const currentStatus = i === 0 ? 'start' : 'continue';

          setCurrentlyGeneratingPage(pageNumInt);
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
            pageNumber: pageNumString,
            notesTheme: latestAssistantData?.notesTheme
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
            
            // Save failed page information for retry
            if (window.electronAPI?.saveFailedPage && latestAssistantData) {
              try {
                await window.electronAPI.saveFailedPage({
                  pageNumber: pageNumInt,
                  subTopicNames: currentSubTopic.names || [],
                  originalTopic: latestAssistantData.topicName || '',
                  sessionId: chatSessionRef.current.sessionId || '',
                  errorMessage: errMsg,
                  timestamp: Date.now(),
                  notesTheme: latestAssistantData.notesTheme as Record<string, unknown> | undefined
                });
              } catch (saveErr) {
                console.error('Failed to save failed page info:', saveErr);
              }
            }
          }
        }

        setCurrentlyGeneratingPage(null);

        if (window.electronAPI?.saveNote && latestAssistantData) {
          const finalImagePaths = pageImagesRef.current.map((image) => ({
            filePath: image.filePath,
            pageNumber: image.pageNumber,
          }));
          await window.electronAPI.saveNote({
            topicId: latestAssistantData.topicId || String(Date.now()),
            topicName: latestAssistantData.topicName || "Untitled Notes",
            subTopics: latestAssistantData.subTopics || [],
            images: finalImagePaths,
            chatUrl: chatSessionRef.current.chatUrl,
            chatSessionId: chatSessionRef.current.sessionId,
            chatSession: chatSessionRef.current.session,
            notesTheme: latestAssistantData.notesTheme,
          });
        }

      } else {
        const responseData = await window.electronAPI?.fillChatGptInput(promptText, attachments);

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
              notesTheme: responseData.notesTheme || prevData.notesTheme,
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
      setCurrentlyGeneratingPage(null);
      setRegeneratingPageNumber(null);
    }
    if (attachments === selectedFiles) {
      setSelectedFiles([]);
      setSelectedImagePageNumber(null);
    }
  }, [isProcessing, assistantData, selectedFiles, selectedImagePageNumber, pageImages, noteTimestamp]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    setAttachmentError(null);
    if (files.length === 0) return;

    // Check if there's already an image selected for regeneration
    const hasImageAttachment = selectedFiles.some(file => file.mimeType.startsWith('image/'));
    if (hasImageAttachment) {
      setAttachmentError('Cannot attach files when an image is selected for regeneration. Deselect the image first.');
      return;
    }

    const availableSlots = Math.max(0, 10 - selectedFiles.length);
    const filesToRead = files.slice(0, availableSlots);
    if (files.length > availableSlots) {
      setAttachmentError('You can attach up to 10 files.');
    }
    if (filesToRead.length === 0) return;

    const readFile = (file: File) => new Promise<ChatAttachment>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const separator = result.indexOf(',');
        if (separator === -1) {
          reject(new Error(`Could not read ${file.name}.`));
          return;
        }
        resolve({
          base64: result.slice(separator + 1),
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          fileSize: file.size,
        });
      };
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      reader.readAsDataURL(file);
    });

    void Promise.all(filesToRead.map(readFile))
      .then((attachments) => setSelectedFiles((current) => [...current, ...attachments].slice(0, 10)))
      .catch((error: Error) => setAttachmentError(error.message));
  };

  const handleRemoveFile = (index: number) => {
    setSelectedFiles((current) => {
      const removedFile = current[index];
      const newFiles = current.filter((_, fileIndex) => fileIndex !== index);
      
      // If the removed file was an image, clear the image page number
      if (removedFile?.mimeType.startsWith('image/')) {
        setSelectedImagePageNumber(null);
      }
      
      return newFiles;
    });
  };

  const handleDeselectImage = () => {
    setSelectedImagePageNumber(null);
    setRegeneratingPageNumber(null);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
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

  const handleImageClick = async (image: GeneratedPageImage) => {
    if (isProcessing) {
      setAttachmentError('Cannot add images while generation is in progress');
      return;
    }

    try {
      const filePath = image.filePath.replace(/^local:\/\//, '');
      const result = await window.electronAPI?.convertLocalImageToBase64?.(filePath);
      
      if (result?.success && result.base64) {
        const fileName = `page-${image.pageNumber}.png`;
        const newAttachment: ChatAttachment = {
          base64: result.base64,
          filename: fileName,
          mimeType: result.mimeType || 'image/png',
          fileSize: result.base64.length * 0.75, // Approximate size for base64
        };
        
        setSelectedFiles((current) => {
          // For image regeneration, only allow one image at a time
          if (current.length >= 1) {
            setAttachmentError('Only one image can be attached for regeneration.');
            return current;
          }
          setSelectedImagePageNumber(image.pageNumber);
          return [newAttachment];
        });
      } else {
        setAttachmentError(result?.error || 'Failed to add image as attachment');
      }
    } catch (error) {
      console.error('Error converting image to attachment:', error);
      setAttachmentError('Failed to add image as attachment');
    }
  };

  const handleRetryFailedPage = async (failedPage: {pageNumber: number; subTopicNames: string[]; originalTopic: string; sessionId: string}) => {
    try {
      setIsProcessing(true);
      setCurrentlyGeneratingPage(failedPage.pageNumber);
      setFailedPages((prev) => {
        const next = { ...prev };
        delete next[failedPage.pageNumber];
        return next;
      });

      const retryPayload = JSON.stringify({
        status: 'retry',
        subTopicNames: failedPage.subTopicNames,
        pageNumber: String(failedPage.pageNumber),
        originalTopic: failedPage.originalTopic,
        notesTheme: assistantData?.notesTheme
      }, null, 2);

      const responseData = await window.electronAPI?.fillChatGptInput(retryPayload);
      
      if (!responseData || responseData === false || (responseData as { error?: unknown })?.error) {
        throw new Error(`Retry failed for page ${failedPage.pageNumber}.`);
      }

      // Remove from failed pages data on success
      setFailedPagesData((prev) => 
        prev.filter(fp => !(fp.pageNumber === failedPage.pageNumber && fp.sessionId === failedPage.sessionId))
      );

      // Remove from storage
      await window.electronAPI?.removeFailedPage?.(failedPage.pageNumber, failedPage.sessionId);

    } catch (retryError) {
      const errMsg = retryError instanceof Error ? retryError.message : `Retry failed for page ${failedPage.pageNumber}.`;
      console.error(errMsg, retryError);
      setFailedPages((prev) => ({ ...prev, [failedPage.pageNumber]: errMsg }));
    } finally {
      setIsProcessing(false);
      setCurrentlyGeneratingPage(null);
    }
  };

  const handleRetryPageDuringGeneration = async (pageNumber: number) => {
    if (!assistantData?.subTopics) return;
    
    const subTopic = assistantData.subTopics[pageNumber - 1];
    if (!subTopic) return;

    try {
      setIsProcessing(true);
      setCurrentlyGeneratingPage(pageNumber);
      setFailedPages((prev) => {
        const next = { ...prev };
        delete next[pageNumber];
        return next;
      });

      const retryPayload = JSON.stringify({
        status: 'retry',
        subTopicNames: subTopic.names || [],
        pageNumber: String(pageNumber),
        originalTopic: assistantData.topicName || '',
        notesTheme: assistantData?.notesTheme
      }, null, 2);

      const responseData = await window.electronAPI?.fillChatGptInput(retryPayload);
      
      if (!responseData || responseData === false || (responseData as { error?: unknown })?.error) {
        throw new Error(`Retry failed for page ${pageNumber}.`);
      }

    } catch (retryError) {
      const errMsg = retryError instanceof Error ? retryError.message : `Retry failed for page ${pageNumber}.`;
      console.error(errMsg, retryError);
      setFailedPages((prev) => ({ ...prev, [pageNumber]: errMsg }));
      
      // Save failed page information for retry
      if (window.electronAPI?.saveFailedPage) {
        try {
          await window.electronAPI.saveFailedPage({
            pageNumber,
            subTopicNames: subTopic.names || [],
            originalTopic: assistantData.topicName || '',
            sessionId: chatSessionRef.current.sessionId || '',
            errorMessage: errMsg,
            timestamp: Date.now(),
          });
        } catch (saveErr) {
          console.error('Failed to save failed page info:', saveErr);
        }
      }
    } finally {
      setIsProcessing(false);
      setCurrentlyGeneratingPage(null);
    }
  };

  const changeProvider = (nextProvider: AIProvider) => {
    if (nextProvider === 'gemini' && isProductionBuild) return;
    if (nextProvider === provider) return;
    window.localStorage.setItem(PROVIDER_STORAGE_KEY, nextProvider);
    setProvider(nextProvider);
    setSelectedFiles([]);
    setSelectedImagePageNumber(null);
    setAttachmentError(null);
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
      <ChatTitleBar
        pageTitle={pageTitle}
        provider={provider}
        isProductionBuild={isProductionBuild}
        hasStartedGeneration={hasStartedGeneration}
        hasPageImages={pageImages.length > 0}
        exportFormat={exportFormat}
        isExporting={isExporting}
        onChangeProvider={changeProvider}
        onChangeExportFormat={setExportFormat}
        onExportNotes={exportNotes}
      />

      <div className="relative flex flex-1 overflow-hidden bg-black">
        {/* Dual Mode View Toggle */}
        {hasStartedGeneration && (
          <div className="absolute top-3 left-4 z-20 flex items-center gap-1 rounded-lg border border-white/10 bg-slate-900/80 p-1 backdrop-blur-md">
            <button
              onClick={() => setViewMode('image')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition ${
                viewMode === 'image'
                  ? 'bg-teal-500/20 text-teal-300 border border-teal-500/30'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              📷 Image View
            </button>
            <button
              onClick={() => setViewMode('markdown')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition ${
                viewMode === 'markdown'
                  ? 'bg-teal-500/20 text-teal-300 border border-teal-500/30'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              📝 Markdown View
            </button>
          </div>
        )}

        {/* Left/Center Area: Gallery View */}
        <div className="custom-scrollbar relative flex flex-1 flex-col overflow-y-auto pb-52 sm:pb-64">
          <div className="mx-auto flex h-max w-full max-w-4xl flex-col gap-4 p-4 pt-12">
            {viewMode === 'markdown' && hasStartedGeneration ? (
              <div className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-950/80 p-6 backdrop-blur-md">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <span className="text-xs font-bold text-teal-400">MARKDOWN PREVIEW</span>
                  <button
                    onClick={() => {
                      void navigator.clipboard.writeText(generateMarkdownPreview());
                      setMarkdownCopied(true);
                      setTimeout(() => setMarkdownCopied(false), 2000);
                    }}
                    className="rounded-md border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-200 transition hover:bg-white/10"
                  >
                    {markdownCopied ? 'Copied!' : 'Copy Markdown'}
                  </button>
                </div>
                <pre className="custom-scrollbar max-h-[60vh] overflow-y-auto whitespace-pre-wrap font-mono text-xs text-slate-200">
                  {generateMarkdownPreview()}
                </pre>
              </div>
            ) : !hasStartedGeneration && assistantData?.status === 'new' && assistantData?.notesTheme ? (
              <NotesThemePreview 
                notesTheme={assistantData.notesTheme}
                topicName={assistantData.topicName}
              />
            ) : hasStartedGeneration && assistantData?.subTopics && assistantData.subTopics.length > 0 ? (
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
                  @keyframes fadeInFromBlur {
                    0% { filter: blur(8px); opacity: 0.3; }
                    100% { filter: blur(0); opacity: 1; }
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
                  .fade-in-from-blur { animation: fadeInFromBlur 1.5s ease-out forwards; }
                `}</style>
                {assistantData.subTopics.map((subTopic, idx) => {
                  const targetPageNum = Number(subTopic.pageNumber || idx + 1);
                  const existingImage = pageImages.find((p) => p.pageNumber === targetPageNum);
                  const isCurrentlyBuilding = currentlyGeneratingPage === targetPageNum;
                  const startTs = pageStartTimes[targetPageNum];
                  const failedMsg = failedPages[targetPageNum];

                  if (existingImage) {
                    const isSelected = selectedImagePageNumber === targetPageNum;
                    const isRegenerating = regeneratingPageNumber === targetPageNum;
                    return (
                      <div key={`page-${targetPageNum}`} className="relative">
                        <img
                          ref={(el) => { imageRefs.current[targetPageNum - 1] = el; }}
                          src={existingImage.filePath}
                          alt={`Generated Page ${targetPageNum}`}
                          loading="lazy"
                          className={`m-0 block h-auto w-full rounded-md border p-0 shadow-lg transition-all duration-1000 ${
                            isRegenerating 
                              ? 'blur-sm opacity-50 cursor-not-allowed border-white/5' 
                              : isProcessing 
                                ? 'cursor-not-allowed opacity-70 border-white/5' 
                                : isSelected 
                                  ? 'cursor-pointer border-teal-500/50 ring-2 ring-teal-500/30' 
                                  : 'cursor-pointer border-white/5 hover:border-white/20'
                          }`}
                          onClick={() => !isProcessing && !isRegenerating && handleImageClick(existingImage)}
                          title={isProcessing ? 'Cannot add images while generation is in progress' : isRegenerating ? 'Regenerating...' : isSelected ? 'Click to deselect' : 'Click to select for regeneration'}
                        />
                        {isRegenerating && (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-md">
                            <div className="flex items-center gap-2">
                              <div className="h-2 w-2 animate-bounce rounded-full bg-teal-400" style={{ animationDelay: '0ms' }} />
                              <div className="h-2 w-2 animate-bounce rounded-full bg-cyan-400" style={{ animationDelay: '150ms' }} />
                              <div className="h-2 w-2 animate-bounce rounded-full bg-teal-300" style={{ animationDelay: '300ms' }} />
                            </div>
                          </div>
                        )}
                        {isSelected && !isProcessing && !isRegenerating && (
                          <div className="absolute top-2 right-2 rounded bg-teal-500/90 px-2 py-1 text-xs font-medium text-white shadow-lg">
                            Selected for regeneration
                          </div>
                        )}
                      </div>
                    );
                  }

                  return (
                    <PageSkeleton
                      key={`skeleton-page-${targetPageNum}`}
                      targetPageNum={targetPageNum}
                      subTopic={subTopic}
                      isCurrentlyBuilding={isCurrentlyBuilding}
                      startTs={startTs}
                      nowMs={nowMs}
                      failedMsg={failedMsg}
                      idx={idx}
                      onRetry={() => handleRetryPageDuringGeneration(targetPageNum)}
                      isProcessing={isProcessing}
                    />
                  );
                })}
              </>
            ) : hasStartedGeneration && pageImages.length > 0 ? (
              <>
                {pageImages.map((img, idx) => {
                  const isSelected = selectedImagePageNumber === img.pageNumber;
                  const isRegenerating = regeneratingPageNumber === img.pageNumber;
                  return (
                    <div key={idx} className="relative">
                      <img
                        ref={(el) => { imageRefs.current[idx] = el; }}
                        src={img.filePath}
                        alt={`Generated Page ${img.pageNumber}`}
                        loading="lazy"
                        className={`m-0 block h-auto w-full rounded-md border p-0 shadow-lg transition-all duration-1000 ${
                          isRegenerating 
                            ? 'blur-sm opacity-50 cursor-not-allowed border-white/5' 
                            : isProcessing 
                              ? 'cursor-not-allowed opacity-70 border-white/5' 
                              : isSelected 
                                ? 'cursor-pointer border-teal-500/50 ring-2 ring-teal-500/30' 
                                : 'cursor-pointer border-white/5 hover:border-white/20'
                        }`}
                        onClick={() => !isProcessing && !isRegenerating && handleImageClick(img)}
                        title={isProcessing ? 'Cannot add images while generation is in progress' : isRegenerating ? 'Regenerating...' : isSelected ? 'Click to deselect' : 'Click to select for regeneration'}
                      />
                      {isRegenerating && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-md">
                          <div className="flex items-center gap-2">
                            <div className="h-2 w-2 animate-bounce rounded-full bg-teal-400" style={{ animationDelay: '0ms' }} />
                            <div className="h-2 w-2 animate-bounce rounded-full bg-cyan-400" style={{ animationDelay: '150ms' }} />
                            <div className="h-2 w-2 animate-bounce rounded-full bg-teal-300" style={{ animationDelay: '300ms' }} />
                          </div>
                        </div>
                      )}
                      {isSelected && !isProcessing && !isRegenerating && (
                        <div className="absolute top-2 right-2 rounded bg-teal-500/90 px-2 py-1 text-xs font-medium text-white shadow-lg">
                          Selected for regeneration
                        </div>
                      )}
                    </div>
                  );
                })}
                
                {/* Failed Pages Retry Section */}
                {failedPagesData.length > 0 && (
                  <div className="mt-6 rounded-xl border border-red-500/30 bg-red-950/20 p-4 backdrop-blur-sm">
                    <h3 className="mb-3 text-sm font-medium text-red-300">Failed Pages</h3>
                    <div className="space-y-2">
                      {failedPagesData.map((failedPage) => (
                        <div 
                          key={`${failedPage.pageNumber}-${failedPage.sessionId}`}
                          className="flex items-center justify-between rounded-lg border border-red-500/20 bg-red-950/10 px-3 py-2"
                        >
                          <div className="flex flex-col">
                            <span className="text-xs font-medium text-red-200">
                              Page {failedPage.pageNumber}
                            </span>
                            <span className="text-[10px] text-red-300/70">
                              {failedPage.subTopicNames.join(', ')}
                            </span>
                          </div>
                          <button
                            onClick={() => handleRetryFailedPage(failedPage)}
                            disabled={isProcessing}
                            className="rounded-lg bg-red-500/20 px-3 py-1 text-xs font-medium text-red-200 transition hover:bg-red-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Retry
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="flex min-h-[50vh] items-center justify-center text-center text-sm text-slate-500" />
            )}

            <div ref={containerEndRef} className="h-4" />
          </div>
        </div>

        {/* Right Sidebar */}
        {assistantData && (
          <ChatOutlineSidebar
            assistantData={assistantData}
            onSubTopicClick={handleSubTopicClick}
          />
        )}

        {/* Floating Input Box & Prompts */}
        <ChatInputArea
          inputText={inputText}
          setInputText={setInputText}
          isProcessing={isProcessing}
          hasStartedGeneration={hasStartedGeneration}
          assistantData={assistantData}
          selectedFiles={selectedFiles}
          setSelectedFiles={setSelectedFiles}
          attachmentError={attachmentError}
          exportMessage={exportMessage}
          provider={provider}
          promptInputRef={promptInputRef}
          onSendPrompt={sendPrompt}
          onFileChange={handleFileChange}
          onKeyDown={handleKeyDown}
          onRemoveFile={handleRemoveFile}
          selectedImagePageNumber={selectedImagePageNumber}
          onDeselectImage={handleDeselectImage}
        />
      </div>
    </div>
  );
}
