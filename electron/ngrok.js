"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startNgrok = startNgrok;
exports.getNgrokSettings = getNgrokSettings;
exports.configureNgrok = configureNgrok;
exports.stopNgrok = stopNgrok;
const ngrok_1 = __importDefault(require("@ngrok/ngrok"));
const electron_1 = require("electron");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
let tunnel = null;
const settingsPath = path_1.default.join(electron_1.app.getPath('userData'), 'ngrok-settings.json');
function readSettings() {
    try {
        const settings = JSON.parse(fs_1.default.readFileSync(settingsPath, 'utf-8'));
        const port = settings.port;
        if (typeof settings.token !== 'string' || typeof port !== 'number' || !Number.isInteger(port))
            return null;
        return { token: settings.token, port, domain: typeof settings.domain === 'string' ? settings.domain : undefined };
    }
    catch {
        return null;
    }
}
async function writeSettings(settings) {
    if (!settings) {
        await fs_1.default.promises.rm(settingsPath, { force: true });
        return;
    }
    await fs_1.default.promises.writeFile(settingsPath, JSON.stringify(settings), 'utf-8');
}
async function startNgrok() {
    const settings = readSettings();
    const token = process.env.NGROK_AUTHTOKEN || settings?.token;
    if (!token) {
        console.log('[ngrok] Skipping tunnel: NGROK_AUTHTOKEN is not set.');
        return;
    }
    process.env.NGROK_AUTHTOKEN = token;
    const port = Number(process.env.NGROK_PORT || settings?.port || 8787);
    const host = process.env.NGROK_HOST || '127.0.0.1';
    const domain = process.env.NGROK_DOMAIN || settings?.domain;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`NGROK_PORT must be a valid TCP port, received: ${port}`);
    }
    tunnel = await ngrok_1.default.forward({
        addr: `${host}:${port}`,
        authtoken_from_env: true,
        ...(domain ? { domain } : {}),
    });
    const publicUrl = tunnel?.url();
    if (!publicUrl)
        throw new Error('Ngrok returned no public URL.');
    console.log(`[ngrok] Forwarding ${publicUrl} to http://${host}:${port}`);
    const websocketUrl = publicUrl.replace(/^https?:\/\//, 'wss://').replace(/\/$/, '') + '/ws';
    console.log(`[ngrok] Mobile WebSocket endpoint: ${websocketUrl}`);
}
async function getNgrokSettings() {
    const settings = readSettings();
    return {
        configured: Boolean(process.env.NGROK_AUTHTOKEN || settings?.token),
        active: Boolean(tunnel),
        url: tunnel?.url() || null,
        port: Number(process.env.NGROK_PORT || settings?.port || 8787),
        domain: process.env.NGROK_DOMAIN || settings?.domain || '',
    };
}
async function configureNgrok(token, port, domain) {
    const savedSettings = readSettings();
    const nextToken = token.trim() || savedSettings?.token || '';
    if (!nextToken) {
        await stopNgrok();
        delete process.env.NGROK_AUTHTOKEN;
        delete process.env.NGROK_DOMAIN;
        await writeSettings(null);
        return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`NGROK_PORT must be a valid TCP port, received: ${port}`);
    }
    const nextDomain = domain.trim();
    await writeSettings({ token: nextToken, port, domain: nextDomain || undefined });
    process.env.NGROK_AUTHTOKEN = nextToken;
    process.env.NGROK_PORT = String(port);
    if (nextDomain)
        process.env.NGROK_DOMAIN = nextDomain;
    else
        delete process.env.NGROK_DOMAIN;
    await stopNgrok();
    await startNgrok();
}
async function stopNgrok() {
    if (!tunnel)
        return;
    try {
        await ngrok_1.default.disconnect();
        await ngrok_1.default.kill();
    }
    catch (error) {
        console.error('[ngrok] Failed to close the tunnel cleanly:', error);
    }
    finally {
        tunnel = null;
    }
}
