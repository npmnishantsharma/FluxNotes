"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getApiToken = getApiToken;
exports.startApiServer = startApiServer;
exports.stopApiServer = stopApiServer;
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const http_1 = require("http");
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const ws_1 = require("ws");
const storage_1 = require("./utils/storage");
const helpers_1 = require("./utils/helpers");
const ACCESS_TTL_MS = 60 * 60 * 1000;
const RENEW_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const apiPort = Number(process.env.FLUXNOTES_API_PORT || 8787);
const apiHost = process.env.FLUXNOTES_API_HOST || '127.0.0.1';
const apiTokenPath = path_1.default.join(electron_1.app.getPath('userData'), 'fluxnotes-api-token');
const signingSecret = (0, crypto_1.randomBytes)(32);
function loadOrCreateApiToken() {
    const configuredToken = process.env.FLUXNOTES_API_TOKEN?.trim();
    if (configuredToken) {
        (0, fs_1.writeFileSync)(apiTokenPath, configuredToken, { encoding: 'utf8', mode: 0o600 });
        (0, fs_1.chmodSync)(apiTokenPath, 0o600);
        return configuredToken;
    }
    try {
        const storedToken = (0, fs_1.readFileSync)(apiTokenPath, 'utf8').trim();
        if (storedToken)
            return storedToken;
    }
    catch {
        // Generate the first token below when the global token file does not exist.
    }
    const generatedToken = (0, crypto_1.randomBytes)(12).toString('base64url');
    (0, fs_1.writeFileSync)(apiTokenPath, generatedToken, { encoding: 'utf8', mode: 0o600 });
    (0, fs_1.chmodSync)(apiTokenPath, 0o600);
    return generatedToken;
}
const apiToken = loadOrCreateApiToken();
let server = null;
let webSocketServer = null;
const sessions = new Map();
function getApiToken() {
    return apiToken;
}
function encode(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}
function sign(value) {
    return (0, crypto_1.createHmac)('sha256', signingSecret).update(value).digest('base64url');
}
function createToken(kind, sessionId, expiresAt) {
    const payload = encode({ kind, sessionId, expiresAt, nonce: (0, crypto_1.randomBytes)(12).toString('hex') });
    return `${payload}.${sign(payload)}`;
}
function readToken(token, expectedKind, sessionId) {
    if (typeof token !== 'string')
        return false;
    const [payload, signature] = token.split('.');
    if (!payload || !signature)
        return false;
    const expectedSignature = sign(payload);
    if (signature.length !== expectedSignature.length)
        return false;
    if (!(0, crypto_1.timingSafeEqual)(Buffer.from(signature), Buffer.from(expectedSignature)))
        return false;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return data.kind === expectedKind && data.sessionId === sessionId
            && typeof data.expiresAt === 'number' && data.expiresAt > Date.now();
    }
    catch {
        return false;
    }
}
function createSession() {
    const sessionId = (0, crypto_1.randomBytes)(16).toString('hex');
    const accessExpiresAt = Date.now() + ACCESS_TTL_MS;
    const renewExpiresAt = Date.now() + RENEW_TTL_MS;
    const session = {
        sessionId,
        accessToken: createToken('access', sessionId, accessExpiresAt),
        renewToken: createToken('renew', sessionId, renewExpiresAt),
        accessExpiresAt,
        renewExpiresAt,
    };
    sessions.set(sessionId, session);
    return session;
}
function renewSession(sessionId, renewToken) {
    const existing = sessions.get(sessionId);
    if (!existing || existing.renewToken !== renewToken || !readToken(renewToken, 'renew', sessionId))
        return null;
    const accessExpiresAt = Date.now() + ACCESS_TTL_MS;
    const session = { ...existing, accessToken: createToken('access', sessionId, accessExpiresAt), accessExpiresAt };
    sessions.set(sessionId, session);
    return session;
}
function authorizedSession(sessionId, token) {
    if (typeof sessionId !== 'string')
        return null;
    const session = sessions.get(sessionId);
    return session && session.accessToken === token && readToken(token, 'access', sessionId) ? session : null;
}
function json(response, statusCode, body) {
    response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
}
function imagePathFromRequest(request) {
    const url = new URL(request.url || '/', `http://${apiHost}:${apiPort}`);
    const encodedPath = url.pathname.replace(/^\/api\/images\//, '');
    if (!encodedPath)
        return null;
    try {
        const imagePath = Buffer.from(decodeURIComponent(encodedPath), 'base64url').toString('utf8');
        const resolvedPath = path_1.default.resolve(imagePath);
        const resolvedImagesDir = path_1.default.resolve(storage_1.imagesDir);
        return resolvedPath.startsWith(`${resolvedImagesDir}${path_1.default.sep}`) ? resolvedPath : null;
    }
    catch {
        return null;
    }
}
function imageUrl(filePath, session) {
    const imageId = Buffer.from(filePath).toString('base64url');
    return `/api/images/${encodeURIComponent(imageId)}?sessionId=${encodeURIComponent(session.sessionId)}&token=${encodeURIComponent(session.accessToken)}`;
}
async function notesPayload(session) {
    const notes = await (0, storage_1.getStoredNotes)();
    return notes.map((note) => ({
        ...note,
        images: (note.images || []).flatMap((image) => {
            const imagePath = path_1.default.resolve((0, helpers_1.fromLocalImageUrl)(image));
            const imagesRoot = path_1.default.resolve(storage_1.imagesDir);
            return imagePath.startsWith(`${imagesRoot}${path_1.default.sep}`) && (0, fs_1.existsSync)(imagePath)
                ? [imageUrl(imagePath, session)]
                : [];
        }),
    }));
}
function sendSocket(socket, body) {
    if (socket.readyState === ws_1.WebSocket.OPEN)
        socket.send(JSON.stringify(body));
}
function handleSocket(socket) {
    let session = null;
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
            const message = JSON.parse(raw.toString());
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
        }
        catch {
            sendSocket(socket, { type: 'error', code: 'INVALID_MESSAGE', message: 'Message must be valid JSON.' });
        }
    });
}
function handleHttp(request, response) {
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
        if (!imagePath || !(0, fs_1.existsSync)(imagePath)) {
            json(response, 404, { error: 'Image not found.' });
            return;
        }
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=3600' });
        (0, fs_1.createReadStream)(imagePath).pipe(response);
        return;
    }
    json(response, 404, { error: 'Not found.' });
}
async function startApiServer() {
    if (server)
        return true;
    if (!apiToken) {
        console.warn('[API] Disabled: set FLUXNOTES_API_TOKEN to enable authenticated access.');
        return false;
    }
    if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
        throw new Error(`Invalid FLUXNOTES_API_PORT: ${apiPort}`);
    }
    server = (0, http_1.createServer)(handleHttp);
    webSocketServer = new ws_1.WebSocketServer({ server, path: '/ws' });
    webSocketServer.on('connection', handleSocket);
    await new Promise((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(apiPort, apiHost, resolve);
    });
    console.log(`[API] WebSocket server listening at ws://${apiHost}:${apiPort}/ws`);
    return true;
}
async function stopApiServer() {
    if (!server)
        return;
    webSocketServer?.close();
    await new Promise((resolve) => server?.close(() => resolve()));
    webSocketServer = null;
    server = null;
    sessions.clear();
}
