const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const puppeteer = require('puppeteer-core');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const CHATGPT_URL = process.env.CHATGPT_URL || 'https://chatgpt.com/';
const USER_DATA_DIR = process.env.USER_DATA_DIR || path.join(__dirname, 'user_data');
const VIEW_FPS = Math.max(1, Math.min(30, Number(process.env.VIEW_FPS || 4)));
const VIEW_QUALITY = Math.max(20, Math.min(100, Number(process.env.VIEW_QUALITY || 70)));
const VIEW_WIDTH = Number(process.env.VIEW_WIDTH || 1280);
const VIEW_HEIGHT = Number(process.env.VIEW_HEIGHT || 800);
const API_TOKEN = (process.env.API_TOKEN || '').trim();
const DESKTOP_CONNECT_PASSWORD = (process.env.DESKTOP_CONNECT_PASSWORD || API_TOKEN || crypto.randomBytes(8).toString('hex')).trim();
const LOG_RESPONSES = !['0', 'false', 'off', 'no'].includes((process.env.LOG_RESPONSES || 'true').toLowerCase());
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const FRAME_INTERVAL_MS = Math.round(1000 / VIEW_FPS);

fs.mkdirSync(USER_DATA_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

let browser = null;
let page = null;
let cdpSession = null;
let isLoggedIn = false;
let currentPageUrl = '';
let loginCheckTimer = null;
let ngrokPublicUrl = null;
let ngrokTunnel = null;
const viewSockets = new Set();
let screencastRunning = false;

function loadEngineScript() {
  const candidates = [
    path.join(__dirname, 'chatgpt-engine.js'),
    path.join(__dirname, '..', 'electron', 'chatgpt-engine.js'),
  ];
  for (const scriptPath of candidates) {
    try {
      if (fs.existsSync(scriptPath)) {
        return fs.readFileSync(scriptPath, 'utf8');
      }
    } catch (_) {}
  }
  console.error('[SERVER] Failed to load chatgpt-engine.js from candidates:', candidates);
  return '';
}

function loadSystemPrompt() {
  const candidates = [
    process.env.PROMPT_FILE,
    path.join(__dirname, 'prompt.md'),
    path.join(__dirname, '..', 'prompt.md'),
  ].filter(Boolean);
  for (const promptPath of candidates) {
    try {
      if (fs.existsSync(promptPath)) {
        return fs.readFileSync(promptPath, 'utf8');
      }
    } catch (_) {}
  }
  console.warn('[SERVER] Could not load prompt.md');
  return '';
}

// PERFORMANCE OPTIMIZATION: In-memory cache for result logs to eliminate synchronous file I/O blocking during server response processing.
let resultLogCache = null;

function appendResultLog(entry) {
  if (!LOG_RESPONSES) return;
  const logPath = path.join(LOG_DIR, 'result.json');
  try {
    if (resultLogCache === null) {
      try {
        const raw = fs.readFileSync(logPath, 'utf8');
        if (raw) resultLogCache = JSON.parse(raw);
        else resultLogCache = [];
      } catch (_) {
        resultLogCache = [];
      }
    }
    resultLogCache.push({ timestamp: new Date().toISOString(), ...entry });
    if (resultLogCache.length > 500) {
      resultLogCache = resultLogCache.slice(-500);
    }
    fs.promises.writeFile(logPath, JSON.stringify(resultLogCache, null, 2)).catch((err) => {
      console.warn('[SERVER] Asynchronous log write failed:', err.message);
    });
  } catch (err) {
    console.warn('[SERVER] Log write failed:', err.message);
  }
}

function findChromeExecutable() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {}
  }
  console.warn('[SERVER] No chrome binary found in candidates; relying on puppeteer default.');
  return undefined;
}

async function launchBrowser() {
  const executablePath = findChromeExecutable();
  console.log('[SERVER] Launching browser' + (executablePath ? ` at ${executablePath}` : ''));
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    userDataDir: USER_DATA_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--mute-audio',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-position=0,0',
      `--window-size=${VIEW_WIDTH},${VIEW_HEIGHT}`,
    ],
    ignoreHTTPSErrors: true,
    acceptInsecureCerts: true,
  });

  const pages = await browser.pages();
  page = pages[0] || (await browser.newPage());
  await page.setViewport({ width: VIEW_WIDTH, height: VIEW_HEIGHT, deviceScaleFactor: 1 });
  page.setDefaultTimeout(60000);

  cdpSession = await page.target().createCDPSession();
  cdpSession.on('Page.screencastFrame', async (meta) => {
    try {
      await cdpSession.send('Page.screencastFrameAck', { sessionId: meta.sessionId });
    } catch (_) {}
    const buf = Buffer.from(meta.data, 'base64');
    const payload = Buffer.alloc(20 + buf.length);
    payload.write('FLUXVIEW', 0, 8, 'ascii');
    payload.writeUInt32BE(1, 8);
    payload.writeUInt32BE(meta.metadata.width || VIEW_WIDTH, 12);
    payload.writeUInt32BE(meta.metadata.height || VIEW_HEIGHT, 16);
    buf.copy(payload, 20);
    for (const ws of viewSockets) {
      if (ws.readyState === 1) try { ws.send(payload); } catch (_) {}
    }
  });
  cdpSession.on('Page.frameNavigated', () => {});

  try {
    await cdpSession.send('Page.enable');
  } catch (_) {}

  await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded' }).catch(err => {
    console.warn('[SERVER] Initial navigation error:', err.message);
  });

  page.on('framenavigated', async (frame) => {
    if (frame === page.mainFrame()) {
      currentPageUrl = page.url();
      console.log('[SERVER] Navigated to:', currentPageUrl);
      broadcastViewEvent({ type: 'url', url: currentPageUrl });
    }
  });

  await injectEngineIfNeeded();
  startLoginCheckRoutine();
}

async function injectEngineIfNeeded() {
  if (!page) return;
  try {
    const loaded = await page.evaluate(() => typeof window.__fluxnotesChatGPT !== 'undefined').catch(() => false);
    if (loaded) return;
    const script = loadEngineScript();
    if (!script) return;
    await page.evaluate(script).catch(err => {
      console.warn('[SERVER] Engine inject evaluate failed:', err && err.message ? err.message : String(err));
    });
    await new Promise(r => setTimeout(r, 200));
    const ok = await page.evaluate(() => typeof window.__fluxnotesChatGPT !== 'undefined').catch(() => false);
    console.log('[SERVER] ChatGPT engine injected:', ok);
  } catch (err) {
    console.warn('[SERVER] Engine injection warning:', err && err.message ? err.message : String(err));
  }
}

async function checkLoginStatus() {
  if (!page) return { loggedIn: false, hasLoginText: true };
  try {
    currentPageUrl = page.url();
    const result = await page.evaluate(() => {
      try {
        const bodyText = document.body ? document.body.innerText : '';
        const hasLoginText = bodyText.includes('Log in') || bodyText.includes('Sign up') || bodyText.includes('Welcome back');
        const hasNewChat = bodyText.includes('New chat') || document.querySelector('[data-testid="profile-button"]') !== null;
        return {
          hasLoginText,
          hasNewChat,
          currentUrl: location.href,
        };
      } catch (e) {
        return { hasLoginText: true, hasNewChat: false, currentUrl: location.href };
      }
    }).catch(() => ({ hasLoginText: true, hasNewChat: false, currentUrl: currentPageUrl }));

    let tokenOk = false;
    try {
      tokenOk = await page.evaluate(async () => {
        try {
          const res = await fetch('/api/auth/session', { credentials: 'include' });
          if (!res.ok) return false;
          const data = await res.json();
          return Boolean(data && data.accessToken);
        } catch (_) {
          return false;
        }
      }).catch(() => false);
    } catch (_) { tokenOk = false; }

    const loggedIn = tokenOk && !result.hasLoginText;
    const onChatGpt = /chatgpt\.com/.test(result.currentUrl || currentPageUrl);
    return {
      loggedIn,
      hasLoginText: result.hasLoginText,
      onChatGpt,
      hasNewChat: result.hasNewChat,
      tokenOk,
      url: result.currentUrl || currentPageUrl,
    };
  } catch (err) {
    return { loggedIn: false, hasLoginText: true, url: currentPageUrl, error: err && err.message ? err.message : String(err) };
  }
}

function startLoginCheckRoutine() {
  if (loginCheckTimer) clearInterval(loginCheckTimer);
  loginCheckTimer = setInterval(async () => {
    const status = await checkLoginStatus();
    const previouslyLoggedIn = isLoggedIn;
    isLoggedIn = status.loggedIn;

    if (status.onChatGpt) {
      if (status.loggedIn) {
        // PERFORMANCE OPTIMIZATION: Strip all CSS from chatgpt.com when user is logged in.
        // Stripping CSS styles in Puppeteer reduces background layout/render calculation
        // and CPU usage while maintaining full API communication functionality.
        if (page && !page.isClosed()) {
          await page.evaluate(() => {
            try {
              const styles = document.querySelectorAll('style, link[rel="stylesheet"]');
              styles.forEach(s => s.remove());
              for (let i = 0; i < document.styleSheets.length; i++) {
                try { document.styleSheets[i].disabled = true; } catch (_) {}
              }
            } catch (_) {}
          }).catch(() => {});
        }
      } else {
        // If not logged in on chatgpt.com but styles were previously stripped, reload page so login interface renders properly
        if (page && !page.isClosed()) {
          const missingStyles = await page.evaluate(() => {
            return document.querySelectorAll('style, link[rel="stylesheet"]').length === 0;
          }).catch(() => false);
          if (missingStyles) {
            await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
          }
        }
      }
    }

    if (status.onChatGpt && !previouslyLoggedIn) {
      await injectEngineIfNeeded().catch(() => {});
    }

    if (!status.onChatGpt && isAuthProviderUrl(status.url)) {
      if (!page.isClosed()) {
        try { await page.bringToFront(); } catch (_) {}
      }
    }
  }, 2000);
}

function isAuthProviderUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const authHosts = [
      'accounts.google.com','google.com','login.microsoftonline.com','login.live.com','microsoft.com',
      'appleid.apple.com','github.com','githubusercontent.com','auth0.com','okta.com',
      'facebook.com','twitter.com','x.com','linkedin.com','discord.com',
    ];
    return authHosts.some(h => host === h || host.endsWith('.' + h));
  } catch { return false; }
}

async function startNgrokIfEnabled() {
  const useNgrok = !['0','false','off','no'].includes((process.env.USE_NGROK || 'false').toLowerCase());
  if (!useNgrok) {
    console.log('[NGROK] USE_NGROK is disabled; skipping tunnel.');
    return;
  }
  const token = process.env.NGROK_AUTHTOKEN;
  if (!token) {
    console.log('[NGROK] USE_NGROK enabled but NGROK_AUTHTOKEN not provided; skipping.');
    return;
  }
  try {
    const ngrok = require('@ngrok/ngrok');
    process.env.NGROK_AUTHTOKEN = token;
    const opts = {
      addr: `${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`,
      authtoken_from_env: true,
    };
    if (process.env.NGROK_DOMAIN) opts.domain = process.env.NGROK_DOMAIN;
    ngrokTunnel = await ngrok.forward(opts);
    ngrokPublicUrl = ngrokTunnel && ngrokTunnel.url ? ngrokTunnel.url() : null;
    if (ngrokPublicUrl) {
      console.log(`[NGROK] Forwarding ${ngrokPublicUrl} -> http://${HOST}:${PORT}`);
      const wsUrl = ngrokPublicUrl.replace(/^https?:\/\//, 'wss://').replace(/\/$/, '') + '/ws/api';
      console.log(`[NGROK] WebSocket: ${wsUrl}`);
    }
  } catch (err) {
    console.error('[NGROK] Failed to start tunnel:', err && err.message ? err.message : String(err));
  }
}

async function stopNgrok() {
  if (!ngrokTunnel) return;
  try {
    const ngrok = require('@ngrok/ngrok');
    await ngrok.disconnect();
    await ngrok.kill();
  } catch (_) {} finally {
    ngrokTunnel = null;
    ngrokPublicUrl = null;
  }
}

function broadcastViewEvent(obj) {
  const str = JSON.stringify(obj);
  for (const ws of viewSockets) {
    if (ws.readyState === 1) try { ws.send(str); } catch (_) {}
  }
}

async function ensureScreencastStarted() {
  if (!cdpSession) return;
  if (screencastRunning) return;
  try {
    await cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality: VIEW_QUALITY,
      maxWidth: VIEW_WIDTH,
      maxHeight: VIEW_HEIGHT,
      everyNthFrame: Math.max(1, Math.round(30 / VIEW_FPS)),
    });
    screencastRunning = true;
    console.log(`[VIEW] CDP screencast started: ${VIEW_FPS}fps, quality=${VIEW_QUALITY}, ${VIEW_WIDTH}x${VIEW_HEIGHT}`);
  } catch (err) {
    console.warn('[VIEW] Failed to start CDP screencast:', err && err.message ? err.message : String(err));
  }
}

async function stopScreencastIfIdle() {
  if (!cdpSession) return;
  if (viewSockets.size > 0) return;
  if (!screencastRunning) return;
  try {
    await cdpSession.send('Page.stopScreencast');
  } catch (_) {}
  screencastRunning = false;
  console.log('[VIEW] CDP screencast stopped (no viewers)');
}

function buildModifiers(e) {
  let m = 0;
  if (e && e.alt) m |= 1;
  if (e && e.ctrl) m |= 2;
  if (e && e.meta) m |= 4;
  if (e && e.shift) m |= 8;
  return m;
}

function cdpHexKey(code) {
  if (!code) return null;
  if (/^Key[A-Z]$/.test(code)) return '0x' + code.charCodeAt(3).toString(16);
  if (/^Digit[0-9]$/.test(code)) return '0x' + code.charCodeAt(5).toString(16);
  return null;
}

async function cdpDispatchMouse(msg) {
  if (!cdpSession || !page) return { ok: false, error: 'no-cdp' };
  const params = {};
  switch (msg.event) {
    case 'moved':
      params.type = 'mouseMoved';
      params.x = Number(msg.x); params.y = Number(msg.y);
      params.modifiers = buildModifiers(msg);
      break;
    case 'pressed':
    case 'released':
      params.type = msg.event === 'pressed' ? 'mousePressed' : 'mouseReleased';
      params.x = Number(msg.x); params.y = Number(msg.y);
      params.modifiers = buildModifiers(msg);
      params.button = msg.button || 'left';
      params.clickCount = Number(msg.clickCount || 1);
      break;
    case 'wheel':
      params.type = 'mouseWheel';
      params.x = Number(msg.x); params.y = Number(msg.y);
      params.modifiers = buildModifiers(msg);
      params.deltaX = Number(msg.deltaX || 0);
      params.deltaY = Number(msg.deltaY || 0);
      break;
    default:
      return { ok: false, error: 'unknown mouse event' };
  }
  try {
    await cdpSession.send('Input.dispatchMouseEvent', params);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function cdpDispatchKey(msg) {
  if (!cdpSession || !page) return { ok: false, error: 'no-cdp' };
  const mods = buildModifiers(msg);
  try {
    if (msg.event === 'type') {
      const text = String(msg.text || '');
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const code = ch.charCodeAt(0);
        const keyText = ch;
        const key = (() => {
          if (ch === '\n') return 'Enter';
          if (ch === '\t') return 'Tab';
          if (ch === '\b') return 'Backspace';
          if (ch === '\r') return 'Enter';
          if (ch === ' ') return 'Space';
          return ch;
        })();
        const winKeyCode = (ch === '\n') ? 13 : (ch === '\t') ? 9 : (ch === '\b') ? 8 : (ch === ' ') ? 32 : code;
        await cdpSession.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          modifiers: mods,
          key,
          code: '',
          windowsVirtualKeyCode: winKeyCode,
          nativeVirtualKeyCode: winKeyCode,
          text: /\r|\n/.test(ch) ? undefined : keyText,
          unmodifiedText: /\r|\n/.test(ch) ? undefined : keyText,
        });
        await cdpSession.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          modifiers: mods,
          key,
          code: '',
          windowsVirtualKeyCode: winKeyCode,
          nativeVirtualKeyCode: winKeyCode,
        });
      }
      return { ok: true };
    }
    const type = msg.event === 'pressed' ? 'rawKeyDown' : (msg.event === 'released' ? 'keyUp' : 'char');
    const params = {
      type,
      modifiers: mods,
    };
    if (msg.key) params.key = msg.key;
    if (msg.code) params.code = msg.code;
    if (typeof msg.text === 'string') params.text = msg.text;
    if (typeof msg.unmodifiedText === 'string') params.unmodifiedText = msg.unmodifiedText;
    if (typeof msg.keyCode === 'number') {
      params.windowsVirtualKeyCode = msg.keyCode;
      params.nativeVirtualKeyCode = msg.keyCode;
    }
    if (msg.code) {
      const hex = cdpHexKey(msg.code);
      if (hex) params.keyCode = parseInt(hex, 16);
    }
    if (msg.event === 'released' && typeof msg.key === 'string' && msg.key.length === 1) {
      // release only needs the key
    }
    await cdpSession.send('Input.dispatchKeyEvent', params);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}


async function sendChatRequest(userText, attachments, sessionId, session) {
  if (!page || !isLoggedIn) throw new Error('Not logged in or browser unavailable');
  await injectEngineIfNeeded();

  const sysPrompt = loadSystemPrompt();

  const result = await page.evaluate(async (ctx) => {
    if (!window.__fluxnotesChatGPT) throw new Error('ChatGPT engine not loaded');
    const W = window.__fluxnotesChatGPT;
    const { userText, sysPrompt, sessionId, session, attachments } = ctx;

    if (session) W.setSession(sessionId, session);
    const currentConvoId = W.getConversationId(sessionId);
    if (!currentConvoId && sysPrompt && sysPrompt.trim() !== '') {
      await W.send(sysPrompt, 'chatgpt', null, sessionId);
      await new Promise(r => setTimeout(r, 2000));
    }

    const messageAttachments = [];
    if (Array.isArray(attachments)) {
      for (const a of attachments) {
        if (!a || !a.base64) continue;
        try {
          const fid = await W.uploadFileToChatGPT(a.base64, a.filename || 'file.bin', a.mimeType || 'application/octet-stream');
          messageAttachments.push({
            imageToken: fid,
            mimeType: a.mimeType || 'application/octet-stream',
            fileSize: a.fileSize || 0,
            filename: a.filename || 'file.bin',
          });
        } catch (_) {}
      }
    }

    let finalOutput = await W.send(userText, 'chatgpt', messageAttachments, sessionId);
    const finalText = String(finalOutput && finalOutput.text ? finalOutput.text : '').trim();

    let handshakeTurn = null;
    let handshakeDelayMs = 0;
    if (!finalText) {
      handshakeDelayMs = 5000;
      await new Promise(r => setTimeout(r, handshakeDelayMs));
      handshakeTurn = await W.send(JSON.stringify({ status: 'SEND_IMAGE_INFO' }), 'chatgpt', null, sessionId);
      finalOutput = handshakeTurn;
    }

    const activeConvoId = finalOutput.conversationId || W.getConversationId(sessionId);
    const useMessageId = finalOutput.messageId || null;
    const generatedImages = Array.isArray(finalOutput.generatedImages) ? finalOutput.generatedImages : [];

    const validHeader = (bytes) => {
      if (!bytes || bytes.length < 16) return false;
      const h = bytes.slice(0, 16);
      const png = [0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A].map(b=>String.fromCharCode(b)).join('');
      const jpg = [0xFF,0xD8,0xFF].map(b=>String.fromCharCode(b)).join('');
      return h.startsWith(png) || h.startsWith(jpg) || h.startsWith('RIFF') || h.startsWith('GIF87a') || h.startsWith('GIF89a');
    };
    const decodeBase64Bytes = (b64) => {
      const s = atob(b64);
      const bytes = new Array(s.length);
      for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
      return bytes;
    };

    const downloads = [];
    for (const img of generatedImages) {
      if (!img || !img.imagePath || !useMessageId) continue;
      let lastErr = null;
      let finalDl = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const dl = await W.downloadSandboxImage(img.imagePath, useMessageId, sessionId);
          if (dl && typeof dl.base64 === 'string' && dl.base64.length > 128) {
            const bytes = decodeBase64Bytes(dl.base64);
            if (validHeader(bytes)) { finalDl = dl; break; }
            lastErr = 'bad file signature';
          } else {
            lastErr = 'missing base64';
          }
        } catch (e) { lastErr = (e && e.message) ? e.message : String(e); }
      }
      if (finalDl) downloads.push({ ...img, download: finalDl });
      else downloads.push({ ...img, downloadError: lastErr || 'validation failed' });
    }

    return {
      rawText: (finalOutput && finalOutput.text) ? finalOutput.text : (typeof finalOutput === 'string' ? finalOutput : ''),
      messageId: useMessageId,
      conversationId: activeConvoId,
      session: W.getSession(sessionId),
      generationId: finalOutput.generationId || null,
      fileId: finalOutput.fileId || null,
      generatedImages,
      downloadedSandboxImages: downloads,
      handshakeTurns: handshakeTurn ? [
        { delayMs: handshakeDelayMs, responseText: handshakeTurn.text || '', messageId: handshakeTurn.messageId || null }
      ] : null,
    };
  }, { userText, sysPrompt, sessionId, session, attachments });

  appendResultLog({
    type: 'chat-response',
    sessionId,
    messageId: result.messageId || null,
    conversationId: result.conversationId || null,
    generationId: result.generationId || null,
    fileId: result.fileId || null,
    response: result.rawText,
    generatedImages: result.generatedImages || null,
    handshakeTurns: result.handshakeTurns || null,
  });

  return result;
}

function extractJsonFromResponse(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  return text.slice(start, end + 1);
}

function completeTruncatedJson(text) {
  if (!text) return '{}';
  let open = 0, openSq = 0, inStr = false, esc = false, quote = '';
  let i = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
    if (c === '{') open++;
    else if (c === '}') open--;
    else if (c === '[') openSq++;
    else if (c === ']') openSq--;
  }
  let out = text;
  while (openSq > 0) { out += ']'; openSq--; }
  while (open > 0) { out += '}'; open--; }
  return out;
}

function completeNotePayload(obj) {
  return obj;
}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'fluxnotes-chatgpt-server',
    browser: Boolean(browser && browser.process && !page?.isClosed()),
    loggedIn: isLoggedIn,
    ngrokUrl: ngrokPublicUrl || null,
    url: currentPageUrl,
  });
});

app.get('/status', (_req, res) => {
  res.json({
    loggedIn: isLoggedIn,
    url: currentPageUrl,
    ngrokUrl: ngrokPublicUrl || null,
    viewFps: VIEW_FPS,
    viewSize: { width: VIEW_WIDTH, height: VIEW_HEIGHT },
    requiresApiToken: Boolean(API_TOKEN),
  });
});

app.get('/view', (_req, res) => {
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Connection': 'keep-alive',
  });

  let closed = false;
  res.on('close', () => { closed = true; });

  const sendFrame = async () => {
    if (closed || !page || page.isClosed()) {
      if (!closed) try { res.end(); } catch (_) {}
      return;
    }
    try {
      const buffer = await page.screenshot({
        type: 'jpeg',
        quality: VIEW_QUALITY,
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: VIEW_WIDTH, height: VIEW_HEIGHT },
      }).catch(() => null);
      if (buffer && !closed) {
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`);
        res.write(buffer);
        res.write('\r\n');
      }
    } catch (_) {}
    if (!closed) setTimeout(sendFrame, FRAME_INTERVAL_MS);
  };
  setTimeout(sendFrame, 50);
});

app.post('/input/click', async (req, res) => {
  if (!page) return res.status(503).json({ error: 'Browser not ready' });
  const { x, y, button = 'left', clickCount = 1 } = req.body || {};
  try {
    await page.mouse.click(Number(x) || 0, Number(y) || 0, { button, clickCount });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/input/move', async (req, res) => {
  if (!page) return res.status(503).json({ error: 'Browser not ready' });
  const { x, y } = req.body || {};
  try {
    await page.mouse.move(Number(x) || 0, Number(y) || 0);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/input/scroll', async (req, res) => {
  if (!page) return res.status(503).json({ error: 'Browser not ready' });
  const { deltaX = 0, deltaY = 0 } = req.body || {};
  try {
    await page.evaluate((dx, dy) => { window.scrollBy(dx, dy); }, Number(deltaX), Number(deltaY));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/input/type', async (req, res) => {
  if (!page) return res.status(503).json({ error: 'Browser not ready' });
  const { text = '' } = req.body || {};
  try {
    await page.keyboard.type(String(text), { delay: 8 });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/input/keypress', async (req, res) => {
  if (!page) return res.status(503).json({ error: 'Browser not ready' });
  const { key = '' } = req.body || {};
  try {
    await page.keyboard.press(String(key));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/navigate', async (req, res) => {
  if (!page) return res.status(503).json({ error: 'Browser not ready' });
  const { url = CHATGPT_URL } = req.body || {};
  try {
    await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await injectEngineIfNeeded().catch(() => {});
    res.json({ ok: true, url: page.url() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/refresh', async (_req, res) => {
  if (!page) return res.status(503).json({ error: 'Browser not ready' });
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await injectEngineIfNeeded().catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const server = http.createServer(app);
const wssApi = new WebSocketServer({ noServer: true });
const wssView = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const pathname = (req.url || '/').split('?')[0].replace(/\/$/, '');
  if (pathname === '/ws/api') {
    wssApi.handleUpgrade(req, socket, head, (ws) => wssApi.emit('connection', ws, req));
  } else if (pathname === '/ws/view') {
    wssView.handleUpgrade(req, socket, head, (ws) => wssView.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

function sendWs(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function authorized(reqToken) {
  if (!API_TOKEN) return true;
  return typeof reqToken === 'string' && reqToken.trim() === API_TOKEN;
}

wssView.on('connection', (ws, _req) => {
  viewSockets.add(ws);
  let viewAuthed = !API_TOKEN;
  console.log('[VIEW] Client connected. Total:', viewSockets.size);

  ensureScreencastStarted().catch((e) => console.warn('[VIEW] start screencast failed:', e && e.message ? e.message : String(e)));

  sendWs(ws, {
    type: 'welcome',
    width: VIEW_WIDTH,
    height: VIEW_HEIGHT,
    fps: VIEW_FPS,
    quality: VIEW_QUALITY,
    requiresApiToken: Boolean(API_TOKEN),
    loggedIn: isLoggedIn,
    url: currentPageUrl,
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    if (!viewAuthed) {
      if (msg.type === 'auth') {
        if (authorized(msg.apiToken)) {
          viewAuthed = true;
          sendWs(ws, { type: 'authenticated', ok: true, loggedIn: isLoggedIn, url: currentPageUrl });
        } else {
          sendWs(ws, { type: 'error', code: 'AUTH_FAILED', message: 'Invalid API token.' });
          ws.close(1008, 'Auth failed');
        }
      }
      return;
    }

    if (msg.type === 'ping') { sendWs(ws, { type: 'pong', timestamp: Date.now() }); return; }
    if (msg.type === 'status') { sendWs(ws, { type: 'status', loggedIn: isLoggedIn, url: currentPageUrl }); return; }
    if (msg.type === 'refresh') {
      if (page && !page.isClosed()) {
        page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      }
      return;
    }
    if (msg.type === 'navigate') {
      const url = String(msg.url || CHATGPT_URL);
      if (page && !page.isClosed()) {
        page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      }
      return;
    }
    if (msg.type === 'mouse') {
      cdpDispatchMouse(msg).then((res) => {
        if (!res.ok && res.error && msg.ack) sendWs(ws, { type: 'ack', ok: false, error: res.error, id: msg.id });
        else if (msg.ack) sendWs(ws, { type: 'ack', ok: true, id: msg.id });
      }).catch(() => {});
      return;
    }
    if (msg.type === 'key') {
      cdpDispatchKey(msg).then((res) => {
        if (!res.ok && res.error && msg.ack) sendWs(ws, { type: 'ack', ok: false, error: res.error, id: msg.id });
        else if (msg.ack) sendWs(ws, { type: 'ack', ok: true, id: msg.id });
      }).catch(() => {});
      return;
    }
  });

  const onClose = () => {
    viewSockets.delete(ws);
    console.log('[VIEW] Client disconnected. Total:', viewSockets.size);
    stopScreencastIfIdle().catch(() => {});
  };
  ws.once('close', onClose);
  ws.once('error', onClose);
});

wssApi.on('connection', (ws, req) => {
  let isAuthed = !API_TOKEN;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) {
      sendWs(ws, { type: 'error', code: 'INVALID_JSON', message: 'Message must be valid JSON.' });
      return;
    }

    if (msg.type === 'sync_session') {
      const reqPassword = String(msg.password || '').trim();
      const isValidPassword = (Boolean(reqPassword) && reqPassword === DESKTOP_CONNECT_PASSWORD) || (Boolean(API_TOKEN) && reqPassword === API_TOKEN);
      if (!isValidPassword) {
        sendWs(ws, { type: 'error', code: 'AUTH_FAILED', message: 'Invalid desktop connect password.' });
        return;
      }
      const cookies = Array.isArray(msg.cookies) ? msg.cookies : [];
      const localStorageData = msg.localStorage && typeof msg.localStorage === 'object' ? msg.localStorage : null;
      const userAgent = typeof msg.userAgent === 'string' ? msg.userAgent : null;

      try {
        if (page && !page.isClosed()) {
          if (userAgent) {
            await page.setUserAgent(userAgent).catch(() => {});
          }
          if (cookies.length > 0) {
            const puppeteerCookies = cookies.map(c => {
              const cookie = {
                name: String(c.name || ''),
                value: String(c.value || ''),
                domain: String(c.domain || '.chatgpt.com'),
                path: String(c.path || '/'),
                httpOnly: Boolean(c.httpOnly),
                secure: Boolean(c.secure),
              };
              if (typeof c.expirationDate === 'number') cookie.expires = c.expirationDate;
              if (c.sameSite) {
                const ss = String(c.sameSite).toLowerCase();
                if (ss.includes('no_restriction') || ss.includes('none')) cookie.sameSite = 'None';
                else if (ss.includes('lax')) cookie.sameSite = 'Lax';
                else if (ss.includes('strict')) cookie.sameSite = 'Strict';
              }
              return cookie;
            }).filter(c => c.name && c.value);
            await page.setCookie(...puppeteerCookies).catch(err => {
              console.warn('[SERVER] setCookie warning:', err.message);
            });
          }
          if (localStorageData) {
            await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
            await page.evaluate((data) => {
              for (const [k, v] of Object.entries(data)) {
                try { localStorage.setItem(k, String(v)); } catch (_) {}
              }
            }, localStorageData).catch(() => {});
          }
          await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
          await injectEngineIfNeeded().catch(() => {});
          const status = await checkLoginStatus();
          isLoggedIn = status.loggedIn;
          sendWs(ws, { type: 'session_synced', ok: true, loggedIn: isLoggedIn, url: page.url() });
        } else {
          sendWs(ws, { type: 'error', code: 'NO_BROWSER', message: 'Browser page unavailable.' });
        }
      } catch (syncErr) {
        sendWs(ws, { type: 'error', code: 'SYNC_FAILED', message: syncErr && syncErr.message ? syncErr.message : String(syncErr) });
      }
      return;
    }

    if (msg.type === 'ping') { sendWs(ws, { type: 'pong', timestamp: Date.now() }); return; }
    if (msg.type === 'auth') {
      if (authorized(msg.apiToken)) {
        isAuthed = true;
        sendWs(ws, { type: 'authenticated', ok: true, loggedIn: isLoggedIn, ngrokUrl: ngrokPublicUrl || null });
      } else {
        sendWs(ws, { type: 'error', code: 'AUTH_FAILED', message: 'Invalid API token.' });
        ws.close(1008, 'Auth failed');
      }
      return;
    }
    if (!isAuthed) {
      sendWs(ws, { type: 'error', code: 'AUTH_REQUIRED', message: 'Send auth with apiToken first.' });
      return;
    }

    if (msg.type === 'status') {
      sendWs(ws, { type: 'status', loggedIn: isLoggedIn, url: currentPageUrl });
      return;
    }

    if (msg.type === 'send') {
      if (!isLoggedIn) {
        sendWs(ws, { type: 'error', code: 'NOT_LOGGED_IN', message: 'Log in first via the browser view.' });
        return;
      }
      const reqId = typeof msg.requestId === 'string' ? msg.requestId : null;
      const userText = String(msg.text || '');
      const sessionId = String(msg.sessionId || ('default-' + Math.random().toString(36).slice(2, 10)));
      const session = msg.session || null;
      const attachments = Array.isArray(msg.attachments) ? msg.attachments : null;

      appendResultLog({ type: 'chat-request', sessionId, requestId: reqId, text: userText, attachments: (attachments || []).map(a => ({ filename: a && a.filename, mimeType: a && a.mimeType })) });

      try {
        const result = await sendChatRequest(userText, attachments, sessionId, session);

        let jsonData = null;
        let parseError = null;
        try {
          const rawText = String(result.rawText || '');
          const jsonSlice = extractJsonFromResponse(rawText);
          if (jsonSlice) {
            jsonData = JSON.parse(completeTruncatedJson(jsonSlice));
            if (jsonData && typeof jsonData === 'object') {
              jsonData = completeNotePayload(jsonData);
              if (result.conversationId) jsonData.chatUrl = `https://chatgpt.com/c/${result.conversationId}`;
              jsonData.chatSessionId = sessionId;
              jsonData.chatSession = result.session;
              if (result.messageId) jsonData.messageId = result.messageId;
              if (result.generationId) jsonData.generationId = result.generationId;
              if (result.fileId) jsonData.fileId = result.fileId;
              if (Array.isArray(result.generatedImages)) jsonData.generatedImages = result.generatedImages;
              if (Array.isArray(result.downloadedSandboxImages)) jsonData.downloadedSandboxImages = result.downloadedSandboxImages;
              if (result.handshakeTurns) jsonData.handshakeTurns = result.handshakeTurns;
            }
          }
        } catch (e) { parseError = (e && e.message) ? e.message : String(e); }

        sendWs(ws, {
          type: 'response',
          requestId: reqId,
          sessionId,
          rawText: result.rawText,
          messageId: result.messageId || null,
          conversationId: result.conversationId || null,
          session: result.session || null,
          generationId: result.generationId || null,
          fileId: result.fileId || null,
          generatedImages: result.generatedImages || [],
          downloadedSandboxImages: result.downloadedSandboxImages || [],
          handshakeTurns: result.handshakeTurns || null,
          json: jsonData,
          parseError,
        });
      } catch (err) {
        appendResultLog({ type: 'chat-error', sessionId, requestId: reqId, error: err && err.message ? err.message : String(err), stack: err && err.stack ? err.stack : null });
        sendWs(ws, {
          type: 'error',
          code: 'CHAT_FAILED',
          requestId: reqId,
          sessionId,
          message: err && err.message ? err.message : String(err),
        });
      }
      return;
    }

    sendWs(ws, { type: 'error', code: 'UNKNOWN_COMMAND', message: 'Unknown command.' });
  });

  ws.on('error', (e) => console.warn('[WS] Socket error:', e.message));
});

async function shutdown() {
  console.log('[SERVER] Shutting down gracefully...');
  if (loginCheckTimer) clearInterval(loginCheckTimer);
  await stopNgrok().catch(() => {});
  try { if (page && !page.isClosed()) await page.close(); } catch (_) {}
  try { if (browser) await browser.close(); } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

(async function start() {
  try {
    await launchBrowser();
  } catch (err) {
    console.error('[SERVER] Failed to launch browser:', err && err.stack ? err.stack : String(err));
    process.exit(1);
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => resolve());
  });

  console.log('==================================================');
  console.log(`[SERVER] DESKTOP CONNECT PASSWORD: ${DESKTOP_CONNECT_PASSWORD}`);
  console.log('==================================================');
  console.log(`[SERVER] HTTP listening on http://${HOST}:${PORT}`);
  console.log(`[SERVER] MJPEG view: http://${HOST}:${PORT}/view (fallback)`);
  console.log(`[SERVER] CDP screencast view WS: ws://${HOST}:${PORT}/ws/view`);
  console.log(`[SERVER] API WebSocket: ws://${HOST}:${PORT}/ws/api`);
  console.log(`[SERVER] Login page: http://${HOST}:${PORT}/`);

  await startNgrokIfEnabled();
})().catch(err => {
  console.error('[SERVER] Startup failure:', err && err.stack ? err.stack : String(err));
  process.exit(1);
});
