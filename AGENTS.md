# Development guidance

## Runtime and build
- Keep Android/Termux as a first-class deployment target. Production should run the prebuilt `dist/server.js` with Node.js 22.12+ and must not require npm installation or frontend build tools on the phone.
- Make frontend and backend changes in TypeScript. Use Preact for new UI and Vite for development/production assets; preserve the existing HTTP API, JSON database, and photo-file behavior.
- Run `npm ci`, `npm run check`, `npm run lint`, and `npm test` for changes affecting application code. `npm test` builds the distribution before running tests.
- Treat `dist/`, `public-assets/app.js`, and `public-assets/admin.js` as generated output. Do not edit or commit generated files.

## Migration boundaries
- The existing gallery/admin scripts still share legacy browser globals and are temporarily emitted as single classic-script bundles. Their TypeScript configs use `noCheck` as a migration bridge; do not copy that setting to new Preact components or modules.
- Keep new Preact UI and shared frontend modules type-checked. Replace legacy script behavior incrementally with tests rather than changing API or interaction contracts in bulk.
- Keep server runtime dependencies to Node.js built-ins. Development/build-only packages belong in `devDependencies`.

## Repository hygiene
- Keep changes focused, preserve user data and existing configuration formats, and update README/deployment instructions when the build or runtime contract changes.
- Use the focused guidance in `src/AGENTS.md`, `public/AGENTS.md`, `test/AGENTS.md`, and `scripts/AGENTS.md` when editing those areas.
