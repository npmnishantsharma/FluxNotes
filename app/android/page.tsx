'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { getMobileValue, mobileKeys, setMobileValue } from './mobile-storage';

export default function AndroidEntryPage() {
  const router = useRouter();
  const [message, setMessage] = useState('Preparing camera scanner...');
  const [isScanning, setIsScanning] = useState(false);

  useEffect(() => {
    void getMobileValue(mobileKeys.hostUrl).then((hostUrl) => {
      if (hostUrl) router.replace('/android/dashboard');
      else void startScan();
    });
  }, [router]);

  const startScan = async () => {
    setIsScanning(true);
    setMessage('Point your camera at the FluxNotes QR code.');
    try {
      const permission = await BarcodeScanner.requestPermissions();
      if (permission.camera !== 'granted') {
        setMessage('Camera permission is required to scan the host QR code.');
        return;
      }
      const result = await BarcodeScanner.scan({ autoZoom: true });
      const rawValue = result.barcodes[0]?.rawValue;
      if (!rawValue) throw new Error('No QR code was detected.');
      const payload = JSON.parse(rawValue) as { host?: unknown; authToken?: unknown };
      const host = typeof payload.host === 'string' ? payload.host.trim().replace(/\/$/, '') : '';
      const authToken = typeof payload.authToken === 'string' ? payload.authToken.trim() : '';
      if (!host || !authToken || !/^wss?:\/\//.test(host) || !host.endsWith('/ws')) {
        throw new Error('This is not a valid FluxNotes host QR code.');
      }
      await setMobileValue(mobileKeys.hostUrl, host);
      await setMobileValue(mobileKeys.hostToken, authToken);
      router.replace('/android/dashboard');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to scan the QR code.');
    } finally {
      setIsScanning(false);
    }
  };

  return (
    <main className="min-h-dvh bg-[#091012] px-5 py-8 text-slate-100">
      <div className="mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-lg flex-col justify-center">
        <div className="rounded-[30px] border border-white/10 bg-[#111a1c] p-6 text-center shadow-2xl shadow-black/30">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-teal-300/10 text-teal-300"><QrIcon /></div>
          <p className="mt-6 text-[11px] font-semibold uppercase tracking-[0.22em] text-teal-300">FluxNotes Mobile</p>
          <h1 className="mt-2 text-2xl font-semibold text-white">Connect to your desktop</h1>
          <p className="mx-auto mt-3 max-w-xs text-sm leading-6 text-slate-500">Scan the QR code shown in FluxNotes desktop Settings to securely import the host URL and auth token.</p>
          <p className="mt-6 rounded-2xl bg-white/[0.04] px-4 py-3 text-sm text-slate-300">{message}</p>
          <button type="button" onClick={() => void startScan()} disabled={isScanning} className="mt-5 flex h-12 w-full items-center justify-center rounded-2xl bg-teal-300 text-sm font-semibold text-[#092022] disabled:cursor-not-allowed disabled:opacity-40">
            {isScanning ? 'Scanning...' : 'Scan QR code'}
          </button>
          <button type="button" onClick={() => router.push('/android/settings')} className="mt-3 text-xs font-semibold text-slate-500 underline underline-offset-4">Enter connection manually</button>
        </div>
      </div>
    </main>
  );
}

function QrIcon() {
  return <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3M21 14v7h-7M17 17h4" /></svg>;
}
