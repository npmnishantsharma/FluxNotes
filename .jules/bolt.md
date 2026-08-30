## 2024-06-25 - [Cache disk read operations for notes data]
**Learning:** `fs.promises.readFile` blocking and repetitive parsing with `JSON.parse` were unnecessary when data is heavily read/modified in-memory first.
**Action:** Always consider maintaining an in-memory cache synchronized with disk writes (using `structuredClone` for deep copying) to minimize I/O for frequently accessed files.
