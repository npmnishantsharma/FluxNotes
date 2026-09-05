const ngrok = require('@ngrok/ngrok');

const port = Number(process.env.NGROK_PORT || 8787);
const host = process.env.NGROK_HOST || '127.0.0.1';
const domain = process.env.NGROK_DOMAIN || '';
let tunnel;
let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[ngrok] Shutting down after ${signal}.`);

  try {
    await ngrok.disconnect();
    await ngrok.kill();
  } catch (error) {
    console.error('[ngrok] Failed to close the tunnel cleanly:', error.message);
    process.exitCode = 1;
  }
}

async function start() {
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

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

start().catch((error) => {
  console.error('[ngrok] Could not start:', error.message);
  console.error('[ngrok] Set NGROK_AUTHTOKEN before running this command.');
  process.exitCode = 1;
});