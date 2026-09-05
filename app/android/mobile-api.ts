import { getMobileDeviceInfo, getMobileValue, mobileKeys, setMobileValue } from './mobile-storage';

export type MobileCommand = {
  type: string;
  [key: string]: unknown;
};

export async function sendMobileCommand<T = Record<string, unknown>>(command: MobileCommand): Promise<T> {
  const [hostUrl, authToken, deviceInfo] = await Promise.all([
    getMobileValue(mobileKeys.hostUrl),
    getMobileValue(mobileKeys.hostToken),
    getMobileDeviceInfo(),
  ]);
  if (!hostUrl || !authToken) throw new Error('Host not configured.');

  return new Promise<T>((resolve, reject) => {
    const socket = new WebSocket(hostUrl);
    let settled = false;
    const timeout = window.setTimeout(() => finish(new Error('Host connection timed out.')), 15000);
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      socket.close();
      if (error) reject(error);
      else resolve(value as T);
    };

    socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', authToken, deviceInfo }));
    socket.onerror = () => finish(new Error('Unable to reach the host.'));
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as Record<string, unknown>;
      if (message.type === 'authenticated') {
        void setMobileValue(mobileKeys.sessionId, String(message.sessionId || ''));
        void setMobileValue(mobileKeys.sessionToken, String(message.token || ''));
        void setMobileValue(mobileKeys.renewToken, String(message.renewToken || ''));
        socket.send(JSON.stringify({ ...command, sessionId: message.sessionId, token: message.token }));
      } else if (message.type === 'error' || message.type === 'command_error') {
        finish(new Error(String(message.message || 'Host command failed.')));
      } else if (message.type === 'notes' || message.type === 'command_result' || message.type === 'device_info' || message.type === 'mobile_info') {
        finish(undefined, message as T);
      }
    };
  });
}
