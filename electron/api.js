"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startApiServer = startApiServer;
exports.stopApiServer = stopApiServer;
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const http_1 = require("http");
const path_1 = __importDefault(require("path"));
const ws_1 = require("ws");
const storage_1 = require("./utils/storage");
const helpers_1 = require("./utils/helpers");
const storage_2 = require("./utils/storage");
const ACCESS_TTL_MS = 60 * 60 * 1000;
const RENEW_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const apiPort = Number(process.env.FLUXNOTES_API_PORT || 8787);
const apiHost = process.env.FLUXNOTES_API_HOST || '127.0.0.1';
const apiPassword = process.env.FLUXNOTES_API_PASSWORD || '';
const signingSecret = (0, crypto_1.randomBytes)(32);
let server = null;
let webSocketServer = null;
const sessions = new Map();
function encode(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}
function sign(value) {
    return (0, crypto_1.createHmac)('sha256', signingSecret).update(value).digest('base64url');
}
function createToken(kind, expiresAt) {
    const payload = encode({ kind, expiresAt, nonce: (0, crypto_1.randomBytes)(12).toString('hex') });
    return `${payload}.${sign(payload)}`;
}
function verifyToken(token, expectedKind) {
    if (!token)
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
        return data.kind === expectedKind && typeof data.expiresAt === 'number' && data.expiresAt > Date.now();
    }
    catch {
        return false;
    }
}
function createSession() {
    const accessExpiresAt = Date.now() + ACCESS_TTL_MS;
    const renewExpiresAt = Date.now() + RENEW_TTL_MS;
    const session = {
        accessToken: createToken('access', accessExpiresAt),
        renewToken: createToken('renew', renewExpiresAt),
        accessExpiresAt,
        renewExpiresAt,
    };
    sessions.set(session.renewToken, session);
    return session;
}
function renewSession(renewToken) {
    const existing = sessions.get(renewToken);
    if (!existing || !verifyToken(renewToken, 'renew'))
        return null;
    const accessExpiresAt = Date.now() + ACCESS_TTL_MS;
    const session = { ...existing, accessToken: createToken('access', accessExpiresAt), accessExpiresAt };
    sessions.set(renewToken, session);
    return session;
}
function isAuthorized(request) {
    const url = new URL(request.url || '/', `http://${apiHost}:${apiPort}`);
    const queryToken = url.searchParams.get('accessToken') || undefined;
    const headerToken = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    return verifyToken(headerToken || queryToken, 'access');
}
function json(response, statusCode, body) {
    response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
}
function imagePathFromRequest(request) {
    const pathname = new URL(request.url || '/', `http://${apiHost}:${apiPort}`).pathname;
    const encodedPath = pathname.replace(/^\/api\/images\//, '');
    if (!encodedPath)
        return null;
    try {
        const imagePath = Buffer.from(decodeURIComponent(encodedPath), 'base64url').toString('utf8');
        const resolvedPath = path_1.default.resolve(imagePath);
        const resolvedImagesDir = path_1.default.resolve(storage_2.imagesDir);
        if (resolvedPath === resolvedImagesDir || !resolvedPath.startsWith(`${resolvedImagesDir}${path_1.default.sep}`))
            return null;
        return resolvedPath;
    }
    catch {
        return null;
    }
}
function imageUrl(filePath, accessToken) {
    const imageId = Buffer.from(filePath).toString('base64url');
    return `/api/images/${encodeURIComponent(imageId)}?accessToken=${encodeURIComponent(accessToken)}`;
}
async function notesPayload(accessToken) {
    const notes = await (0, storage_1.getStoredNotes)();
    return notes.map((note) => ({
        ...note,
        images: (note.images || []).flatMap((image) => {
            const imagePath = path_1.default.resolve((0, helpers_1.fromLocalImageUrl)(image));
            const imagesRoot = path_1.default.resolve(storage_2.imagesDir);
            return imagePath.startsWith(`${imagesRoot}${path_1.default.sep}`) && (0, fs_1.existsSync)(imagePath)
                ? [imageUrl(imagePath, accessToken)]
                : [];
        }),
    }));
}
function sendSocket(socket, body) {
    if (socket.readyState === ws_1.WebSocket.OPEN)
        socket.send(JSON.stringify(body));
}
function handleSocket(socket) {
    let accessToken = null;
    socket.on('message', async (raw) => {
        try {
            const message = JSON.parse(raw.toString());
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
        }
        catch {
            sendSocket(socket, { type: 'error', code: 'INVALID_MESSAGE', message: 'Message must be valid JSON.' });
        }
    });
}
function handleHttp(request, response) {
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
        return;
    if (!apiPassword) {
        console.warn('[API] Disabled: set FLUXNOTES_API_PASSWORD to enable authenticated access.');
        return;
    }
    if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535)
        throw new Error(`Invalid FLUXNOTES_API_PORT: ${apiPort}`);
    server = (0, http_1.createServer)(handleHttp);
    webSocketServer = new ws_1.WebSocketServer({ server, path: '/ws' });
    webSocketServer.on('connection', handleSocket);
    await new Promise((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(apiPort, apiHost, resolve);
    });
    console.log(`[API] WebSocket server listening at ws://${apiHost}:${apiPort}/ws`);
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
