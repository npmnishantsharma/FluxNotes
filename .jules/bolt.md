## 2026-09-02 - [Electron IPC Caching]
**Learning:** Caching data in Electron's main process can lead to subtle bugs if the cached objects are returned directly, as subsequent operations on the returned data might mutate the shared cache reference.
**Action:** Always use `structuredClone()` when returning or updating cached objects to ensure full isolation across request lifecycles.
