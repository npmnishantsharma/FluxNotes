## 2025-05-18 - CSS Stripping for ChatGPT Worker Window Performance
**Learning:** Stripping all `<style>` and `<link rel="stylesheet">` elements and disabling document styleSheets on `chatgpt.com` in background worker automation windows (Electron and Puppeteer) significantly reduces layout calculations and background GPU/CPU utilization while keeping all API communication intact.
**Action:** When running automated background browser instances that interact with web APIs via DOM/injected JS, strip non-essential CSS stylesheets when logged in and restore them when user interaction/login is required.

## 2025-05-19 - In-Memory Storage Caching and Real-Time WebSocket Syncing
**Learning:** Caching persistence state in memory with `structuredClone` for IPC and mobile handlers eliminates blocking disk I/O, while persistent WebSocket connections with push broadcasts enable instant cross-device updates between Desktop and Android.
**Action:** Always maintain an in-memory storage cache updated strictly after asynchronous file writes succeed, and push change events over WebSocket connections for instant UI updates.
