import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { createReadStream, existsSync } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import { getStoredNotes } from './utils/storage';
import { fromLocalImageUrl } from './utils/helpers';
import { imagesDir } from './utils/storage';
import { NoteRecord } from './types';

const ACCESS_TTL_MS = 60 * 60 * 1000;
const RENEW_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const apiPort = Number(process.env.FLUXNOTES_API_PORT || 8787);
const apiHost = process.env.FLUXNOTES_API_HOST || '127.0.0.1';
const apiPassword = process.env.FLUXNOTES_API_PASSWORD || '';
const signingSecret = randomBytes(32);

let server: Server | null = null;
let webSocketServer: WebSocketServer | null = null;

type Session = {
  accessToken: string;
  renewToken: string;
  accessExpiresAt: number;
  renewExpiresAt: number;
};

const sessions = new Map<string, Session>();

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sign(value: string): string {
  return createHmac('sha256', signingSecret).update(value).digest('base64url');
}

function createToken(kind: 'access' | 'renew', expiresAt: number): string {
  const payload = encode({ kind, expiresAt, nonce: randomBytes(12).toString('hex') });
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token: string | undefined, expectedKind: 'access' | 'renew'): boolean {
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expectedSignature = sign(payload);
  if (signature.length !== expectedSignature.length) return false;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return false;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { kind?: string; expiresAt?: number };
    return data.kind === expectedKind && typeof data.expiresAt === 'number' && data.expiresAt > Date.now();
  } catch {
    return false;
  }
}

function createSession(): Session {
  const accessExpiresAt = Date.now() + ACCESS_TTL_MS;
  const renewExpiresAt = Date.now() + RENEW_TTL_MS;
  const session: Session = {
    accessToken: createToken('access', accessExpiresAt),
    renewToken: createToken('renew', renewExpiresAt),
    accessExpiresAt,
    renewExpiresAt,
  };
  sessions.set(session.renewToken, session);
  return session;
}

function renewSession(renewToken: string): Session | null {
  const existing = sessions.get(renewToken);
  if (!existing || !verifyToken(renewToken, 'renew')) return null;
  const accessExpiresAt = Date.now() + ACCESS_TTL_MS;
  const session = { ...existing, accessToken: createToken('access', accessExpiresAt), accessExpiresAt };
  sessions.set(renewToken, session);
  return session;
}

function isAuthorized(request: IncomingMessage): boolean {
  const url = new URL(request.url || '/', `http://${apiHost}:${apiPort}`);
  const queryToken = url.searchParams.get('accessToken') || undefined;
  const headerToken = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  return verifyToken(headerToken || queryToken, 'access');
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function imagePathFromRequest(request: IncomingMessage): string | null {
  const pathname = new URL(request.url || '/', `http://${apiHost}:${apiPort}`).pathname;
  const encodedPath = pathname.replace(/^\/api\/images\//, '');
  if (!encodedPath) return null;

  try {
    const imagePath = Buffer.from(decodeURIComponent(encodedPath), 'base64url').toString('utf8');
    const resolvedPath = path.resolve(imagePath);
    const resolvedImagesDir = path.resolve(imagesDir);
    if (resolvedPath === resolvedImagesDir || !resolvedPath.startsWith(`${resolvedImagesDir}${path.sep}`)) return null;
    return resolvedPath;
  } catch {
    return null;
  }
}

function imageUrl(filePath: string, accessToken: string): string {
  const imageId = Buffer.from(filePath).toString('base64url');
  return `/api/images/${encodeURIComponent(imageId)}?accessToken=${encodeURIComponent(accessToken)}`;
}

async function notesPayload(accessToken: string): Promise<NoteRecord[]> {
  const notes = await getStoredNotes();
  return notes.map((note) => ({
    ...note,
    images: (note.images || []).flatMap((image) => {
      const imagePath = path.resolve(fromLocalImageUrl(image));
      const imagesRoot = path.resolve(imagesDir);
      return imagePath.startsWith(`${imagesRoot}${path.sep}`) && existsSync(imagePath)
        ? [imageUrl(imagePath, accessToken)]
        : [];
    }),
  }));
}

function sendSocket(socket: WebSocket, body: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(body));
}

function handleSocket(socket: WebSocket): void {
  let accessToken: string | null = null;

  socket.on('message', async (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as { type?: string; password?: string; renewToken?: string; sessionCode?: string };

      if (message.type === 'auth') {
        if (!apiPassword || message.password !== apiPassword) {
          sendSocket(socket, { type: 'error', code: 'AUTH_FAILED', message: 'Invalid credentials.' });
          socket.close(1008, 'Authentication failed');
          return;
        }
        const session = createSession();
        accessToken = session.accessToken;
        sendSocket(socket, {
          type: 'authenticated',
          sessionCode: session.accessToken,
          renewToken: session.renewToken,
          expiresAt: session.accessExpiresAt,
          renewExpiresAt: session.renewExpiresAt,
        });
        return;
      }

      if (message.type === 'renew') {
        const session = renewSession(message.renewToken || '');
        if (!session) {
          sendSocket(socket, { type: 'error', code: 'RENEW_FAILED', message: 'Renewal token is invalid or expired.' });
          return;
        }
        accessToken = session.accessToken;
        sendSocket(socket, { type: 'renewed', sessionCode: session.accessToken, expiresAt: session.accessExpiresAt });
        return;
      }

      if (!accessToken || !verifyToken(message.sessionCode || accessToken, 'access')) {
        sendSocket(socket, { type: 'error', code: 'AUTH_REQUIRED', message: 'Authenticate before using this connection.' });
        return;
      }

      if (message.type === 'list_notes') {
        sendSocket(socket, { type: 'notes', notes: await notesPayload(accessToken) });
        return;
      }

      sendSocket(socket, { type: 'error', code: 'UNKNOWN_COMMAND', message: 'Unknown command.' });
    } catch {
      sendSocket(socket, { type: 'error', code: 'INVALID_MESSAGE', message: 'Message must be valid JSON.' });
    }
  });
}

function handleHttp(request: IncomingMessage, response: ServerResponse): void {
  const pathname = new URL(request.url || '/', `http://${apiHost}:${apiPort}`).pathname;

  if (pathname === '/health') {
    json(response, 200, { ok: true, service: 'fluxnotes-api' });
    return;
  }

  if (pathname.startsWith('/api/images/')) {
    if (!isAuthorized(request)) {
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

export async function startApiServer(): Promise<void> {
  if (server) return;
  if (!apiPassword) {
    console.warn('[API] Disabled: set FLUXNOTES_API_PASSWORD to enable authenticated access.');
    return;
  }
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) throw new Error(`Invalid FLUXNOTES_API_PORT: ${apiPort}`);

  server = createServer(handleHttp);
  webSocketServer = new WebSocketServer({ server, path: '/ws' });
  webSocketServer.on('connection', handleSocket);
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(apiPort, apiHost, resolve);
  });
  console.log(`[API] WebSocket server listening at ws://${apiHost}:${apiPort}/ws`);
}

export async function stopApiServer(): Promise<void> {
  if (!server) return;
  webSocketServer?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  webSocketServer = null;
  server = null;
  sessions.clear();
}
