import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, createReadStream, readFileSync, writeFileSync, chmodSync } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { app } from 'electron';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import { getStoredNotes, imagesDir } from './utils/storage';
import { fromLocalImageUrl } from './utils/helpers';

const ACCESS_TTL_MS = 60 * 60 * 1000;
const RENEW_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const apiPort = Number(process.env.FLUXNOTES_API_PORT || 8787);
const apiHost = process.env.FLUXNOTES_API_HOST || '127.0.0.1';
const apiTokenPath = path.join(app.getPath('userData'), 'fluxnotes-api-token');
const signingSecret = randomBytes(32);

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

function createSession(): Session {
  const sessionId = randomBytes(16).toString('hex');
  const accessExpiresAt = Date.now() + ACCESS_TTL_MS;
  const renewExpiresAt = Date.now() + RENEW_TTL_MS;
  const session: Session = {
    sessionId,
    accessToken: createToken('access', sessionId, accessExpiresAt),
    renewToken: createToken('renew', sessionId, renewExpiresAt),
    accessExpiresAt,
    renewExpiresAt,
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
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
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

function imageUrl(filePath: string, session: Session): string {
  const imageId = Buffer.from(filePath).toString('base64url');
  return `/api/images/${encodeURIComponent(imageId)}?sessionId=${encodeURIComponent(session.sessionId)}&token=${encodeURIComponent(session.accessToken)}`;
}

async function notesPayload(session: Session): Promise<unknown[]> {
  const notes = await getStoredNotes();
  return notes.map((note) => ({
    ...note,
    images: (note.images || []).flatMap((image) => {
      const imagePath = path.resolve(fromLocalImageUrl(image));
      const imagesRoot = path.resolve(imagesDir);
      return imagePath.startsWith(`${imagesRoot}${path.sep}`) && existsSync(imagePath)
        ? [imageUrl(imagePath, session)]
        : [];
    }),
  }));
}

function sendSocket(socket: WebSocket, body: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(body));
}

function handleSocket(socket: WebSocket): void {
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
        session = createSession();
        sendSocket(socket, {
          type: 'authenticated',
          sessionId: session.sessionId,
          token: session.accessToken,
          renewToken: session.renewToken,
          expiresAt: session.accessExpiresAt,
          renewExpiresAt: session.renewExpiresAt,
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
        sendSocket(socket, { type: 'notes', notes: await notesPayload(authorized) });
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
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=3600' });
    createReadStream(imagePath).pipe(response);
    return;
  }

  json(response, 404, { error: 'Not found.' });
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
  webSocketServer = new WebSocketServer({ server, path: '/ws' });
  webSocketServer.on('connection', handleSocket);
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(apiPort, apiHost, resolve);
  });
  console.log(`[API] WebSocket server listening at ws://${apiHost}:${apiPort}/ws`);
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
