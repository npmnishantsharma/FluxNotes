## 2024-06-25 - Manual Accessibility for Custom Window Controls
**Learning:** Custom Electron window controls (mimicking native OS controls) lack native accessibility features by default. Users navigating with a keyboard or screen reader may miss these entirely if not manually instrumented.
**Action:** Always add explicit `aria-label` attributes and implement `focus-visible` styles on custom window control buttons to ensure they match native accessibility expectations.
