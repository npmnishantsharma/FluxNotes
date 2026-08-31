## 2025-08-31 - O(N^2) render loop caused by Array.find() inside Array.map()
**Learning:** Using `Array.find()` inside a React `.map()` render loop results in O(N^2) complexity, which can severely degrade performance for lists with many items.
**Action:** Optimize list lookups in render functions by pre-computing an O(1) Map using `useMemo` outside the loop.
