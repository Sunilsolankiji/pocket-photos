# Backend guidance

- Keep the production backend dependency-free beyond Node.js built-ins; do not add build tools or UI libraries to runtime imports.
- Preserve existing API routes, authorization boundaries, JSON database migrations, file naming, and Termux/mobile storage behavior.
- Prefer explicit types for persisted data, HTTP boundaries, and asynchronous results. The server TypeScript project currently has `strict: false` for staged migration; do not weaken checks further, and keep new contracts typed.
- The production entrypoint is `dist/server.js`; source-root/config resolution must work both through `tsx` in development and compiled output.
- Add or update integration coverage in `test/` for externally observable behavior.
