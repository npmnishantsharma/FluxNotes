## 2024-09-02 - Accessible Custom Window Controls
**Learning:** Custom window controls in Electron apps (like close, minimize, maximize) often lack native accessibility attributes because they are built using generic buttons and SVGs.
**Action:** Always add explicit `aria-label` and `title` attributes to icon-only window control buttons, and ensure full keyboard accessibility by utilizing Tailwind `focus-visible` classes (e.g., `focus-visible:outline-none focus-visible:bg-white/10`).
