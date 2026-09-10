import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, createReadStream, readFileSync, writeFileSync, chmodSync } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { app } from 'electron';
import os from 'os';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import { getStoredNotes, imagesDir, saveNotesCollection } from './utils/storage';
import { fromLocalImageUrl } from './utils/helpers';

const ACCESS_TTL_MS = 60 * 60 * 1000;
const RENEW_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MOBILE_WS_PATH = '/ws/api';
const LEGACY_WS_PATH = '/ws';
const apiPort = Number(process.env.FLUXNOTES_API_PORT || 8787);
const apiHost = process.env.FLUXNOTES_API_HOST || '127.0.0.1';
const apiTokenPath = path.join(app.getPath('userData'), 'fluxnotes-api-token');
const responseLogPath = path.join(app.getPath('userData'), 'response.json');
const requestLogPath = path.join(app.getPath('userData'), 'request.json');
const signingSecret = randomBytes(32);

function responseLoggingEnabled(): boolean {
  return !['0', 'false', 'off', 'no'].includes((process.env.FLUXNOTES_API_RESPONSE_LOGGING || 'true').toLowerCase());
}

function responseSensitiveDataEnabled(): boolean {
  return !['0', 'false', 'off', 'no'].includes((process.env.FLUXNOTES_API_RESPONSE_LOG_SENSITIVE || 'true').toLowerCase());
}

function redactResponse(value: unknown): unknown {
  if (responseSensitiveDataEnabled()) return value;
  if (typeof value === 'string') {
    return value.replace(/((?:authToken|accessToken|renewToken|sessionToken|token)=)[^&\s"}]+/gi, '$1[redacted]');
  }
  if (Array.isArray(value)) return value.map(redactResponse);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => (
      [/token/i, /password/i, /secret/i].some((pattern) => pattern.test(key))
        ? [key, '[redacted]']
        : [key, redactResponse(nestedValue)]
    )));
  }
  return value;
}

function logResponse(transport: 'websocket' | 'http', response: unknown, metadata?: Record<string, unknown>): void {
  if (!responseLoggingEnabled()) return;
  try {
    let entries: Record<string, unknown>[] = [];
    try {
      const existing = JSON.parse(readFileSync(responseLogPath, 'utf8'));
      if (Array.isArray(existing)) entries = existing;
    } catch {
      // Start a new response log when the file does not exist or is invalid.
    }
    entries.push({ timestamp: new Date().toISOString(), transport, ...metadata, response: redactResponse(response) });
    writeFileSync(responseLogPath, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode: 0o600 });
    chmodSync(responseLogPath, 0o600);
  } catch (error) {
    console.error('[API] Failed to write response log:', error);
  }
}

function logRequest(transport: 'websocket' | 'http', request: unknown, metadata?: Record<string, unknown>): void {
  if (!responseLoggingEnabled()) return;
  try {
    let entries: Record<string, unknown>[] = [];
    try {
      const existing = JSON.parse(readFileSync(requestLogPath, 'utf8'));
      if (Array.isArray(existing)) entries = existing;
    } catch {
      // Start a new request log when the file does not exist or is invalid.
    }
    entries.push({ timestamp: new Date().toISOString(), transport, ...metadata, request: redactResponse(request) });
    writeFileSync(requestLogPath, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode: 0o600 });
    chmodSync(requestLogPath, 0o600);
  } catch (error) {
    console.error('[API] Failed to write request log:', error);
  }
}

function readLogFile(filePath: string): Record<string, unknown>[] {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8'));
    return Array.isArray(value) ? value.slice(-200) : [];
  } catch {
    return [];
  }
}

function clearLogFile(filePath: string): void {
  writeFileSync(filePath, '[]', { encoding: 'utf8', mode: 0o600 });
  chmodSync(filePath, 0o600);
}

function loadOrCreateApiToken(): string {
  const configuredToken = process.env.FLUXNOTES_API_TOKEN?.trim();
  if (configuredToken) {
    writeFileSync(apiTokenPath, configuredToken, { encoding: 'utf8', mode: 0o600 });
    chmodSync(apiTokenPath, 0o600);
    return configuredToken;
  }

  try {
    const storedToken = readFileSync(apiTokenPath, 'utf8').trim();
    if (storedToken) return storedToken;
  } catch {
    // Generate the first token below when the global token file does not exist.
  }

  const generatedToken = randomBytes(12).toString('base64url');
  writeFileSync(apiTokenPath, generatedToken, { encoding: 'utf8', mode: 0o600 });
  chmodSync(apiTokenPath, 0o600);
  return generatedToken;
}

const apiToken = loadOrCreateApiToken();

type Session = {
  sessionId: string;
  accessToken: string;
  renewToken: string;
  accessExpiresAt: number;
  renewExpiresAt: number;
  clientDeviceInfo: DeviceInfo;
};

type DeviceInfo = {
  deviceId?: string;
  deviceName?: string;
  platform?: string;
  model?: string;
  osVersion?: string;
  appVersion?: string;
  clientType?: string;
};

let server: Server | null = null;
let webSocketServer: WebSocketServer | null = null;
const sessions = new Map<string, Session>();

export function getApiToken(): string {
  return apiToken;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sign(value: string): string {
  return createHmac('sha256', signingSecret).update(value).digest('base64url');
}

function createToken(kind: 'access' | 'renew', sessionId: string, expiresAt: number): string {
  const payload = encode({ kind, sessionId, expiresAt, nonce: randomBytes(12).toString('hex') });
  return `${payload}.${sign(payload)}`;
}

function readToken(token: unknown, expectedKind: 'access' | 'renew', sessionId: string): boolean {
  if (typeof token !== 'string') return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;

  const expectedSignature = sign(payload);
  if (signature.length !== expectedSignature.length) return false;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return false;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      kind?: string;
      sessionId?: string;
      expiresAt?: number;
    };
    return data.kind === expectedKind && data.sessionId === sessionId
      && typeof data.expiresAt === 'number' && data.expiresAt > Date.now();
  } catch {
    return false;
  }
}

function sanitizeDeviceInfo(value: unknown): DeviceInfo {
  if (!value || typeof value !== 'object') return {};
  const input = value as Record<string, unknown>;
  const info: DeviceInfo = {};
  for (const key of ['deviceId', 'deviceName', 'platform', 'model', 'osVersion', 'appVersion', 'clientType']) {
    const field = input[key];
    if (typeof field === 'string' && field.trim()) info[key as keyof DeviceInfo] = field.trim().slice(0, 128);
  }
  return info;
}

function serverDeviceInfo(): DeviceInfo {
  return {
    deviceId: createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 16),
    deviceName: os.hostname(),
    platform: process.platform,
    model: process.arch,
    osVersion: os.release(),
    appVersion: app.getVersion(),
    clientType: 'fluxnotes-desktop',
  };
}

function createSession(clientDeviceInfo: DeviceInfo): Session {
  const sessionId = randomBytes(16).toString('hex');
  const accessExpiresAt = Date.now() + ACCESS_TTL_MS;
  const renewExpiresAt = Date.now() + RENEW_TTL_MS;
  const session: Session = {
    sessionId,
    accessToken: createToken('access', sessionId, accessExpiresAt),
    renewToken: createToken('renew', sessionId, renewExpiresAt),
    accessExpiresAt,
    renewExpiresAt,
    clientDeviceInfo,
  };
  sessions.set(sessionId, session);
  return session;
}

function renewSession(sessionId: string, renewToken: unknown): Session | null {
  const existing = sessions.get(sessionId);
  if (!existing || existing.renewToken !== renewToken || !readToken(renewToken, 'renew', sessionId)) return null;

  const accessExpiresAt = Date.now() + ACCESS_TTL_MS;
  const session = { ...existing, accessToken: createToken('access', sessionId, accessExpiresAt), accessExpiresAt };
  sessions.set(sessionId, session);
  return session;
}

function authorizedSession(sessionId: unknown, token: unknown): Session | null {
    if (typeof sessionId !== 'string') return null;
  const session = sessions.get(sessionId);
  return session && session.accessToken === token && readToken(token, 'access', sessionId) ? session : null;
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  logResponse('http', body, { statusCode, contentType: 'application/json' });
  response.writeHead(statusCode, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

function imagePathFromRequest(request: IncomingMessage): string | null {
  const url = new URL(request.url || '/', `http://${apiHost}:${apiPort}`);
  const encodedPath = url.pathname.replace(/^\/api\/images\//, '');
  if (!encodedPath) return null;

  try {
    const imagePath = Buffer.from(decodeURIComponent(encodedPath), 'base64url').toString('utf8');
    const resolvedPath = path.resolve(imagePath);
    const resolvedImagesDir = path.resolve(imagesDir);
    return resolvedPath.startsWith(`${resolvedImagesDir}${path.sep}`) ? resolvedPath : null;
  } catch {
    return null;
  }
}

function imageContentType(imagePath: string): string {
  switch (path.extname(imagePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/png';
  }
}

function imageDataUrl(filePath: string): string {
  return `data:${imageContentType(filePath)};base64,${readFileSync(filePath).toString('base64')}`;
}

async function notesPayload(): Promise<unknown[]> {
  const notes = await getStoredNotes();
  return notes.map((note) => ({
    ...note,
    images: (note.images || []).flatMap((image) => {
      // Handle both old format (string) and new format (object with filePath and pageNumber)
      const imagePath = typeof image === 'string' 
        ? fromLocalImageUrl(image) 
        : fromLocalImageUrl(image.filePath);
      const resolvedPath = path.resolve(imagePath);
      const imagesRoot = path.resolve(imagesDir);
      return resolvedPath.startsWith(`${imagesRoot}${path.sep}`) && existsSync(resolvedPath)
        ? [imageDataUrl(resolvedPath)]
        : [];
    }),
  }));
}

function sendSocket(socket: WebSocket, body: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    logResponse('websocket', body);
    socket.send(JSON.stringify(body));
  }
}

function mobileInfo(session: Session): Record<string, unknown> {
  return {
    appName: 'FluxNotes',
    appVersion: app.getVersion(),
    apiVersion: 1,
    transport: 'websocket',
    endpoint: MOBILE_WS_PATH,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    accessTokenExpiresAt: session.accessExpiresAt,
    renewTokenExpiresAt: session.renewExpiresAt,
    serverDeviceInfo: serverDeviceInfo(),
    clientDeviceInfo: session.clientDeviceInfo,
    capabilities: ['list_notes', 'get_device_info', 'get_mobile_info', 'ping', 'renew'],
  };
}

function handleSocket(socket: WebSocket, request: IncomingMessage): void {
  const requestPath = new URL(request.url || '/', `http://${apiHost}:${apiPort}`).pathname.replace(/\/$/, '');
  if (requestPath !== MOBILE_WS_PATH && requestPath !== LEGACY_WS_PATH) {
    socket.close(1008, 'Unsupported WebSocket path');
    return;
  }
  let session: Session | null = null;
  let isAlive = true;
  const heartbeat = setInterval(() => {
    if (!isAlive) {
      socket.terminate();
      return;
    }
    isAlive = false;
    socket.ping();
  }, HEARTBEAT_INTERVAL_MS);

  socket.on('pong', () => {
    isAlive = true;
  });
  socket.on('close', () => {
    clearInterval(heartbeat);
  });

  socket.on('message', async (raw) => {
    try {
      logRequest('websocket', raw.toString(), { path: 'websocket-message' });
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;

      if (message.type === 'ping') {
        sendSocket(socket, { type: 'pong', timestamp: Date.now() });
        return;
      }

      if (message.type === 'auth') {
        if (!apiToken || message.authToken !== apiToken) {
          sendSocket(socket, { type: 'error', code: 'AUTH_FAILED', message: 'Invalid API token.' });
          socket.close(1008, 'Authentication failed');
          return;
        }
        session = createSession(sanitizeDeviceInfo(message.deviceInfo));
        sendSocket(socket, {
          type: 'authenticated',
          sessionId: session.sessionId,
          token: session.accessToken,
          renewToken: session.renewToken,
          expiresAt: session.accessExpiresAt,
          renewExpiresAt: session.renewExpiresAt,
          mobileInfo: mobileInfo(session),
        });
        return;
      }

      if (message.type === 'renew') {
        const renewed = renewSession(String(message.sessionId || ''), message.renewToken);
        if (!renewed) {
          sendSocket(socket, { type: 'error', code: 'RENEW_FAILED', message: 'Renewal credentials are invalid or expired.' });
          return;
        }
        session = renewed;
        sendSocket(socket, { type: 'renewed', sessionId: renewed.sessionId, token: renewed.accessToken, expiresAt: renewed.accessExpiresAt });
        return;
      }

      const authorized = session && authorizedSession(message.sessionId, message.token);
      if (!authorized) {
        sendSocket(socket, { type: 'error', code: 'AUTH_REQUIRED', message: 'Send a valid sessionId and token.' });
        return;
      }

      if (message.type === 'list_notes') {
        sendSocket(socket, { type: 'notes', notes: await notesPayload() });
        return;
      }

      if (message.type === 'rename_note' || message.type === 'set_note_pinned' || message.type === 'delete_note') {
        const notes = await getStoredNotes();
        const topicId = typeof message.topicId === 'string' ? message.topicId : '';
        const noteIndex = notes.findIndex((note) => note.topicId === topicId);
        if (noteIndex < 0) {
          sendSocket(socket, { type: 'command_error', code: 'NOTE_NOT_FOUND', message: 'Note not found.' });
          return;
        }
        if (message.type === 'rename_note') {
          const topicName = typeof message.topicName === 'string' ? message.topicName.trim() : '';
          if (!topicName) {
            sendSocket(socket, { type: 'command_error', code: 'INVALID_NAME', message: 'A note name is required.' });
            return;
          }
          notes[noteIndex] = { ...notes[noteIndex], topicName };
        } else if (message.type === 'set_note_pinned') {
          notes[noteIndex] = { ...notes[noteIndex], pinned: Boolean(message.pinned) };
        } else {
          notes.splice(noteIndex, 1);
        }
        await saveNotesCollection(notes);
        sendSocket(socket, { type: 'command_result', command: message.type, success: true });
        return;
      }

      if (message.type === 'get_mobile_info' || message.type === 'get_device_info') {
        const info = mobileInfo(authorized);
        sendSocket(socket, {
          type: message.type === 'get_device_info' ? 'device_info' : 'mobile_info',
          info,
        });
        return;
      }

      if (message.type === 'get_logs') {
        sendSocket(socket, {
          type: 'logs',
          requestLog: readLogFile(requestLogPath),
          responseLog: readLogFile(responseLogPath),
        });
        return;
      }

      if (message.type === 'clear_logs') {
        clearLogFile(requestLogPath);
        clearLogFile(responseLogPath);
        sendSocket(socket, { type: 'command_result', command: message.type, success: true });
        return;
      }

      sendSocket(socket, { type: 'error', code: 'UNKNOWN_COMMAND', message: 'Unknown command.' });
    } catch {
      sendSocket(socket, { type: 'error', code: 'INVALID_MESSAGE', message: 'Message must be valid JSON.' });
    }
  });
}

function handleHttp(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url || '/', `http://${apiHost}:${apiPort}`);
  logRequest('http', {
    method: request.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: request.headers,
  });

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
    });
    response.end();
    return;
  }

  if (url.pathname === '/health') {
    json(response, 200, { ok: true, service: 'fluxnotes-api' });
    return;
  }

  if (url.pathname.startsWith('/api/images/')) {
    const session = authorizedSession(url.searchParams.get('sessionId'), url.searchParams.get('token'));
    if (!session) {
      json(response, 401, { error: 'Authentication required.' });
      return;
    }

    const imagePath = imagePathFromRequest(request);
    if (!imagePath || !existsSync(imagePath)) {
      json(response, 404, { error: 'Image not found.' });
      return;
    }
    const contentType = imageContentType(imagePath);
    logResponse('http', { type: 'image', path: path.basename(imagePath) }, { statusCode: 200, contentType });
    response.writeHead(200, {
      'access-control-allow-origin': '*',
      'content-type': contentType,
      'cache-control': 'private, max-age=3600',
    });
    createReadStream(imagePath).pipe(response);
    return;
  }

  json(response, 404, { error: 'Not found.' });
}

export async function broadcastNotesUpdate(): Promise<void> {
  if (!webSocketServer || webSocketServer.clients.size === 0) return;
  try {
    const notes = await notesPayload();
    const payload = JSON.stringify({ type: 'notes_updated', notes });
    for (const client of webSocketServer.clients) {
      if (client.readyState === WebSocket.OPEN) {
        logResponse('websocket', { type: 'notes_updated', noteCount: notes.length });
        client.send(payload);
      }
    }
  } catch (err) {
    console.error('[API] Failed to broadcast notes update:', err);
  }
}

export async function startApiServer(): Promise<boolean> {
  if (server) return true;
  if (!apiToken) {
    console.warn('[API] Disabled: set FLUXNOTES_API_TOKEN to enable authenticated access.');
    return false;
  }
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new Error(`Invalid FLUXNOTES_API_PORT: ${apiPort}`);
  }

  server = createServer(handleHttp);
  webSocketServer = new WebSocketServer({ server });
  webSocketServer.on('connection', handleSocket);
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(apiPort, apiHost, resolve);
  });
  console.log(`[API] WebSocket server listening at ws://${apiHost}:${apiPort}${MOBILE_WS_PATH}`);
  return true;
}

export async function stopApiServer(): Promise<void> {
  if (!server) return;
  webSocketServer?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  webSocketServer = null;
  server = null;
  sessions.clear();
}
