"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processAiPrompt = processAiPrompt;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const helpers_1 = require("../utils/helpers");
const storage_1 = require("../utils/storage");
const gemini_1 = require("./gemini");
const chatgpt_1 = require("./chatgpt");
async function processAiPrompt(workerWindow, mainWindow, userText, provider, activeSessionId, activeSession, isGeminiSessionInitialized, attachments) {
    const sessionId = activeSessionId || (0, helpers_1.createChatSessionId)();
    let session = activeSession || { conversationId: null, parentMessageId: null };
    let geminiInitialized = isGeminiSessionInitialized;
    let promptContent = '';
    try {
        const promptPath = path_1.default.join(__dirname, '..', '..', 'prompt.md');
        if (fs_1.default.existsSync(promptPath)) {
            promptContent = fs_1.default.readFileSync(promptPath, 'utf-8');
        }
    }
    catch (error) {
        console.error('Failed to read prompt.md:', error);
    }
    let result = null;
    if (provider === 'gemini') {
        await (0, gemini_1.injectGeminiEngineIfNeeded)(workerWindow);
        const geminiPromptContent = promptContent.replace(/### Your Image Response[\s\S]*?(?=### Info On Image Generation)/, '');
        const isGeminiImageCommand = (() => {
            try {
                const parsed = JSON.parse(userText);
                return parsed.status === 'start' || parsed.status === 'continue';
            }
            catch {
                return /["']?status["']?\s*:\s*["'](?:start|continue)["']/i.test(userText);
            }
        })();
        const geminiResult = await workerWindow.webContents.executeJavaScript(`
      (async function() {
        if (!window.__fluxnotesGeminiUnified) {
          throw new Error("Gemini engine not loaded.");
        }

        const sysPrompt = ${JSON.stringify(geminiPromptContent)};
        const usrText = ${JSON.stringify(userText)};
        const sessionId = ${JSON.stringify(sessionId)};
        ${geminiInitialized ? '' : `if (sysPrompt.trim()) await window.__fluxnotesGeminiUnified.send(sysPrompt, '3.1-pro', null, sessionId);`}
        const response = await window.__fluxnotesGeminiUnified.send(usrText, '3.1-pro', null, sessionId);
        return { rawText: String(response || ''), session: null };
      })();
    `);
        geminiInitialized = true;
        const downloadedGeminiImages = isGeminiImageCommand
            ? await (0, gemini_1.downloadGeminiImages)(geminiResult?.rawText || '')
            : [];
        result = {
            rawText: geminiResult?.rawText || '',
            conversationId: null,
            messageId: null,
            session: null,
            generationId: null,
            fileId: null,
            generatedImages: downloadedGeminiImages.map(({ download, ...image }) => image),
            downloadedSandboxImages: downloadedGeminiImages,
        };
    }
    else {
        await (0, chatgpt_1.injectChatGptEngineIfNeeded)(workerWindow);
        result = await workerWindow.webContents.executeJavaScript(`
      (async function() {
        if (!window.__fluxnotesChatGPT) {
          throw new Error("fluxnotes engine not loaded.");
        }

        const sysPrompt = ${JSON.stringify(promptContent)};
        const usrText = ${JSON.stringify(userText)};
        const sessionId = ${JSON.stringify(sessionId)};
        const session = ${JSON.stringify(session)};
        const uploadedAttachments = ${JSON.stringify(attachments || [])};
        window.__fluxnotesChatGPT.setSession(sessionId, session);

        const currentConvoId = window.__fluxnotesChatGPT.getConversationId(sessionId);

        if (!currentConvoId && sysPrompt.trim() !== "") {
          console.log("[INJECTION] Sending initial system prompt to thread...");
          await window.__fluxnotesChatGPT.send(sysPrompt, 'chatgpt', null, sessionId);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        const messageAttachments = [];
        for (const uploadedAttachment of uploadedAttachments) {
          const fileId = await window.__fluxnotesChatGPT.uploadFileToChatGPT(
            uploadedAttachment.base64,
            uploadedAttachment.filename,
            uploadedAttachment.mimeType,
          );
          messageAttachments.push({
            imageToken: fileId,
            mimeType: uploadedAttachment.mimeType,
            fileSize: uploadedAttachment.fileSize,
            filename: uploadedAttachment.filename,
          });
        }

        console.log("[INJECTION] Sending user query to the same conversation thread...");
        let finalOutput = await window.__fluxnotesChatGPT.send(usrText, 'chatgpt', messageAttachments, sessionId);
        const finalText = String(finalOutput && finalOutput.text ? finalOutput.text : "").trim();

        if (!finalText) {
          console.log("[INJECTION] Empty image response text. Sending SEND_IMAGE_INFO request.");
          finalOutput = await window.__fluxnotesChatGPT.send(JSON.stringify({ status: "SEND_IMAGE_INFO" }), 'chatgpt', null, sessionId);
        }

        const activeConvoId = finalOutput.conversationId || window.__fluxnotesChatGPT.getConversationId(sessionId);
        const useMessageId = finalOutput.messageId || null;

        const generatedImages = Array.isArray(finalOutput.generatedImages) ? finalOutput.generatedImages : [];
        const dedupedGeneratedImages = [];
        const dedupeMap = new Map();
        for (const img of generatedImages) {
          if (!img || (!img.imagePath && !img.fileId && !img.generationId)) continue;
          const key = String(img.imagePath || img.fileId || img.generationId || '').trim();
          if (!key) continue;
          const existing = dedupeMap.get(key);
          if (!existing) {
            dedupeMap.set(key, { ...img });
            dedupedGeneratedImages.push({ ...img });
          } else {
            Object.entries(img).forEach(([field, value]) => {
              if (value != null && value !== '' && (existing[field] == null || existing[field] === '')) {
                existing[field] = value;
              }
            });
          }
        }

        const validateSandboxDownload = function (download) {
          if (!download || typeof download.base64 !== 'string' || download.base64.length < 128) {
            return { valid: false, reason: 'missing or tiny base64 payload' };
          }
          try {
            const decoded = atob(download.base64);
            if (decoded.length < 64) {
              return { valid: false, reason: 'payload too short to be a valid image' };
            }
            const header = decoded.slice(0, 16);
            const pngHeader = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A].map((byte) => String.fromCharCode(byte)).join('');
            const jpegStart = [0xFF, 0xD8, 0xFF].map((byte) => String.fromCharCode(byte)).join('');
            const hasValidHeader =
              header.startsWith(pngHeader) ||
              header.startsWith(jpegStart) ||
              header.startsWith('RIFF') ||
              header.startsWith('GIF87a') ||
              header.startsWith('GIF89a');
            if (!hasValidHeader) {
              return { valid: false, reason: 'bad file signature' };
            }
            return { valid: true };
          } catch (error) {
            return { valid: false, reason: (error && error.message) ? error.message : String(error) };
          }
        };

        const downloadOneSandboxImage = async function (img) {
          const attempts = 2;
          for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
              const download = await window.__fluxnotesChatGPT.downloadSandboxImage(img.imagePath, useMessageId, sessionId);
              const validation = validateSandboxDownload(download);
              if (validation.valid) {
                console.log("[ELECTRON] Valid sandbox image download confirmed:", {
                  imagePath: img.imagePath,
                  attempt,
                  size: download && typeof download.size === 'number' ? download.size : null,
                });
                return { ...img, download };
              }
              console.warn("[ELECTRON] Invalid sandbox image payload; retrying:", {
                imagePath: img.imagePath,
                attempt,
                reason: validation.reason,
              });
              if (attempt === attempts) {
                return { ...img, downloadError: validation.reason || 'Invalid sandbox image payload' };
              }
            } catch (error) {
              const message = error && error.message ? error.message : String(error);
              console.warn("[ELECTRON] Sandbox image download failed; retrying:", {
                imagePath: img.imagePath,
                attempt,
                reason: message,
              });
              if (attempt === attempts) {
                return { ...img, downloadError: message };
              }
            }
          }
          return { ...img, downloadError: 'Sandbox image failed validation after retries' };
        };

        const sandboxDownloads = [];
        for (let gi = 0; gi < dedupedGeneratedImages.length; gi++) {
          const img = dedupedGeneratedImages[gi];
          if (img && img.imagePath && useMessageId && typeof window.__fluxnotesChatGPT.downloadSandboxImage === 'function') {
            console.log("[ELECTRON] Starting sandbox image download from generated image payload:", {
              imagePath: img.imagePath,
              fileId: img.fileId || null,
              generationId: img.generationId || null,
              messageId: useMessageId,
              sessionId: sessionId || null,
            });
            sandboxDownloads.push(downloadOneSandboxImage(img));
          }
        }
        const downloadedImages = sandboxDownloads.length ? await Promise.all(sandboxDownloads) : [];

        return {
          rawText: finalOutput.text || finalOutput,
          messageId: useMessageId,
          conversationId: activeConvoId,
          session: window.__fluxnotesChatGPT.getSession(sessionId),
          generationId: finalOutput.generationId || null,
          fileId: finalOutput.fileId || null,
          generatedImages: dedupedGeneratedImages,
          downloadedSandboxImages: downloadedImages,
        };
      })();
    `);
    }
    if (result) {
        const { rawText = '', conversationId, messageId, session: resSession, generationId, fileId, generatedImages, downloadedSandboxImages } = result;
        session = resSession || session;
        await (0, storage_1.writeRawResponse)({
            provider: provider || 'chatgpt',
            sessionId,
            timestamp: new Date().toISOString(),
            rawResponse: rawText,
        });
        (0, storage_1.appendToResultJson)({
            sessionId: sessionId || null,
            messageId: messageId || null,
            conversationId: conversationId || null,
            generationId: generationId || null,
            fileId: fileId || null,
            response: rawText,
            generatedImages: generatedImages || null,
        });
        if (Array.isArray(downloadedSandboxImages) && downloadedSandboxImages.length > 0) {
            for (const img of downloadedSandboxImages) {
                if (!img || !img.download || !img.download.base64)
                    continue;
                const base64Data = String(img.download.base64);
                const ext = (img.download.mimeType && img.download.mimeType.split('/')[1]) || 'png';
                const safeExt = ext === 'jpeg' ? 'jpg' : ext.replace(/[^a-zA-Z0-9]/g, '');
                const usedFileId = String(img.fileId || fileId || generationId || messageId || 'unknown');
                const noteIdValue = String(sessionId || messageId || 'note');
                const fileName = `image_${(0, helpers_1.safeFileName)(noteIdValue)}_${(0, helpers_1.safeFileName)(usedFileId)}.${safeExt}`;
                const filePath = path_1.default.join(storage_1.imagesDir, fileName);
                try {
                    console.log('[ELECTRON] Saving downloaded sandbox image to disk:', {
                        imagePath: img.imagePath || null,
                        fileId: img.fileId || fileId || null,
                        generationId: img.generationId || generationId || null,
                        destination: filePath,
                    });
                    fs_1.default.writeFileSync(filePath, base64Data, 'base64');
                    console.log('[ELECTRON] Sandbox image saved locally:', filePath);
                    await (0, storage_1.saveRecordToDb)({ id: usedFileId, filePath, timestamp: Date.now(), source: 'sandbox', generationId: img.generationId || generationId || undefined, fileId: img.fileId || fileId || undefined });
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('new-image', { filePath: (0, helpers_1.toLocalImageUrl)(filePath), pageNumber: null });
                        console.log('[ELECTRON] Sent new-image event with local path:', (0, helpers_1.toLocalImageUrl)(filePath));
                    }
                }
                catch (saveErr) {
                    const err = saveErr;
                    console.error('[ELECTRON] Failed to save sandbox image locally:', err.message);
                }
            }
        }
        if (!rawText) {
            return { resultPayload: null, newSessionId: sessionId, newSession: session, newGeminiInitialized: geminiInitialized };
        }
        try {
            const jsonText = (0, helpers_1.extractJsonFromResponse)(rawText);
            const jsonData = (0, helpers_1.completeNotePayload)(JSON.parse((0, helpers_1.completeTruncatedJson)(jsonText)));
            if (conversationId) {
                jsonData.chatUrl = `https://chatgpt.com/c/${conversationId}`;
            }
            jsonData.chatSessionId = sessionId;
            jsonData.chatSession = session;
            if (messageId)
                jsonData.messageId = messageId;
            if (generationId)
                jsonData.generationId = generationId;
            if (fileId)
                jsonData.fileId = fileId;
            if (Array.isArray(generatedImages))
                jsonData.generatedImages = generatedImages;
            console.log('[ELECTRON] Successfully processed conversation and images:', jsonData.topicName);
            return { resultPayload: jsonData, newSessionId: sessionId, newSession: session, newGeminiInitialized: geminiInitialized };
        }
        catch (parseErr) {
            const err = parseErr;
            console.error('[ELECTRON] JSON Parse Error:', err.message);
            return {
                resultPayload: { error: 'Failed to parse JSON', raw: rawText, messageId, conversationId, generationId, fileId, generatedImages },
                newSessionId: sessionId,
                newSession: session,
                newGeminiInitialized: geminiInitialized,
            };
        }
    }
    return { resultPayload: null, newSessionId: sessionId, newSession: session, newGeminiInitialized: geminiInitialized };
}
