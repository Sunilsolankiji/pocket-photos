#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./src/config');
const { createApp, lanAddresses, fallbackDataDir } = require('./src/app');
const { Store } = require('./src/store');

/** `node server.js --reset-admin-password`: forget the admin password (stop the server first). */
async function resetAdmin() {
  const cfg = loadConfig();
  const files = [cfg.dataDir, fallbackDataDir(cfg)].map((d) => path.join(d, 'db.json')).filter((f) => fs.existsSync(f));
  if (!files.length) {
    console.log('No database found - nothing to reset.');
    return;
  }
  for (const f of files) {
    const store = new Store(f);
    store.load();
    if (!store.data.admin) continue;
    delete store.data.admin;
    await store.close();
    console.log(`Admin password removed from ${f}`);
  }
  console.log('Start PocketPhotos again and open http://localhost:<port>/admin on the phone to choose a new one.');
  console.log('(If the server was still running, stop it and run this command again.)');
}

async function main() {
  if (process.argv.includes('--reset-admin-password')) return resetAdmin();
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
  if (!app.adminAuth.isSet) console.log('    (first visit: choose an admin password)');
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
