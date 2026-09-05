import ngrok from '@ngrok/ngrok';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';

let tunnel: Awaited<ReturnType<typeof ngrok.forward>> | null = null;
const settingsPath = path.join(app.getPath('userData'), 'ngrok-settings.json');

type NgrokSettings = {
  token: string;
  port: number;
  domain?: string;
};

function readSettings(): NgrokSettings | null {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Partial<NgrokSettings>;
    const port = settings.port;
    if (typeof settings.token !== 'string' || typeof port !== 'number' || !Number.isInteger(port)) return null;
    return { token: settings.token, port, domain: typeof settings.domain === 'string' ? settings.domain : undefined };
  } catch {
    return null;
  }
}

async function writeSettings(settings: NgrokSettings | null): Promise<void> {
  if (!settings) {
    await fs.promises.rm(settingsPath, { force: true });
    return;
  }
  await fs.promises.writeFile(settingsPath, JSON.stringify(settings), 'utf-8');
}

export async function startNgrok(): Promise<void> {
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

  tunnel = await ngrok.forward({
    addr: `${host}:${port}`,
    authtoken_from_env: true,
    ...(domain ? { domain } : {}),
  });

  console.log(`[ngrok] Forwarding ${tunnel.url()} to http://${host}:${port}`);
  console.log('[ngrok] WebSocket clients can use the wss:// URL matching this tunnel.');
}

export async function getNgrokSettings(): Promise<{ configured: boolean; active: boolean; url: string | null; port: number; domain: string }> {
  const settings = readSettings();
  return {
    configured: Boolean(process.env.NGROK_AUTHTOKEN || settings?.token),
    active: Boolean(tunnel),
    url: tunnel?.url() || null,
    port: Number(process.env.NGROK_PORT || settings?.port || 8787),
    domain: process.env.NGROK_DOMAIN || settings?.domain || '',
  };
}

export async function configureNgrok(token: string, port: number, domain: string): Promise<void> {
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
  if (nextDomain) process.env.NGROK_DOMAIN = nextDomain;
  else delete process.env.NGROK_DOMAIN;
  await stopNgrok();
  await startNgrok();
}

export async function stopNgrok(): Promise<void> {
  if (!tunnel) return;

  try {
    await ngrok.disconnect();
    await ngrok.kill();
  } catch (error) {
    console.error('[ngrok] Failed to close the tunnel cleanly:', error);
  } finally {
    tunnel = null;
  }
}