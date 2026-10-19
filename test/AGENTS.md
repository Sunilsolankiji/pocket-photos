# Test guidance

- Use Node's built-in test runner and keep tests deterministic with temporary directories and ephemeral ports.
- `npm test` builds the production distribution before running the suite; integration tests that exercise static assets or startup/reset commands should target `dist/`.
- Preserve tests for authorization, data migration, photo-library behavior, and Termux-compatible runtime paths when restructuring.
- Optional ffmpeg/ffprobe/OpenSSL behavior should skip or conditionally assert only where the existing suite already establishes that convention.
