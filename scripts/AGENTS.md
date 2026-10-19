# Deployment script guidance

- Keep scripts POSIX-shell compatible with Termux's Bash/sh environment and avoid requiring npm or development dependencies at runtime.
- `termux-install.sh` installs runtime packages, validates the Node.js floor and prebuilt distribution, then configures media storage and boot startup.
- `start.sh` launches `dist/server.js` and retains the wake-lock/restart behavior.
- Keep install/build instructions consistent with README.md; production builds happen on a computer before deployment.
