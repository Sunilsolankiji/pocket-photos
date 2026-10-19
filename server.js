#!/usr/bin/env node
'use strict';
const { loadConfig } = require('./src/config');
const { createApp, lanAddresses } = require('./src/app');

async function main() {
  const cfg = loadConfig();
  const app = await createApp(cfg);
  const addr = await app.start();
  const port = addr.port;
  console.log(`\n  PocketPhotos is running`);
  console.log(`  Media library : ${cfg.mediaDir}${app.lib.readOnly ? '  (READ-ONLY: uploads/deletes disabled)' : ''}`);
  console.log(`  Data/thumbs   : ${cfg.dataDir}`);
  console.log(`  ffmpeg        : ${app.tools.ffmpeg ? 'yes' : 'NOT FOUND (no video thumbnails / HEIC previews)'}`);
  console.log(`  ffprobe       : ${app.tools.ffprobe ? 'yes' : 'NOT FOUND (no video dates/durations)'}`);
  console.log(`\n  Open in a browser on your home Wi-Fi:`);
  console.log(`    http://localhost:${port}`);
  const localOnly = ['127.0.0.1', 'localhost', '::1'].includes(cfg.host);
  const ips = localOnly ? [] : lanAddresses();
  for (const ip of ips) console.log(`    http://${ip}:${port}`);
  if (localOnly) console.log(`    (bound to ${cfg.host} only - set host to 0.0.0.0 to allow other devices)`);
  else if (!ips.length) console.log(`    http://<phone-wifi-ip>:${port}   (see Settings > Connections > Wi-Fi > your network > IP address)`);
  console.log(`\n  Admin page (create users) - open ON THIS PHONE only:\n    http://localhost:${port}/admin`);
  if (app.tls.enabled) {
    const host = app.publicHostName();
    console.log(`\n  HTTPS for access from outside (port-forward ${app.tls.address.port} on your router):`);
    console.log(`    https://${host || '<your-public-ip-or-duckdns-name>'}:${app.tls.address.port}`);
  } else if (cfg.httpsPort) {
    console.log(`\n  HTTPS is OFF: ${app.tls.error}`);
  }
  console.log('');

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log('Shutting down...');
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error('Failed to start:', e.message);
  process.exit(1);
});
