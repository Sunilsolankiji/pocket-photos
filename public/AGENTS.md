# Frontend guidance

- Use Preact components for new UI and keep them type-checked through `tsconfig.ui.json`.
- Preserve the mobile-first layout, accessible labels/status messages, existing DOM IDs used by the legacy scripts, and the server's same-origin Content Security Policy.
- The old gallery/admin scripts share globals and are compiled as classic bundles. Their TypeScript projects temporarily use `noCheck`; avoid adding new logic there when a typed Preact/module implementation is practical.
- Keep Vite's production output and public assets compatible with static serving from `dist/public/`. Verify both the photo and admin entry pages in the built output.
- Keep icons self-contained SVGs with accessible labels on interactive controls. Place stable public assets (including `/icon.svg`) in `public-assets/` so manifests and runtime-generated markup can reference them without hashed filenames.
