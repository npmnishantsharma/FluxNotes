import { Preferences } from '@capacitor/preferences';
import { Device } from '@capacitor/device';

export const mobileKeys = {
  hostUrl: 'fluxnotes-android-host-url',
  hostToken: 'fluxnotes-android-host-token',
  deviceId: 'fluxnotes-android-device-id',
  sessionId: 'fluxnotes-android-session-id',
  sessionToken: 'fluxnotes-android-session-token',
  renewToken: 'fluxnotes-android-renew-token',
} as const;

export async function getMobileValue(key: string): Promise<string> {
  const { value } = await Preferences.get({ key });
  return value || '';
}

export async function setMobileValue(key: string, value: string): Promise<void> {
  await Preferences.set({ key, value });
}

export async function getMobileDeviceInfo(): Promise<Record<string, string>> {
  const [id, info] = await Promise.all([Device.getId(), Device.getInfo()]);
  return {
    deviceId: id.identifier,
    deviceName: info.name || info.model || 'Android device',
    platform: info.platform,
    model: info.model,
    osVersion: info.osVersion,
    appVersion: '1.0.0',
    clientType: 'fluxnotes-android',
  };
}
