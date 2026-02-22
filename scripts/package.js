#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const VERSION = require(path.join(ROOT, 'extension', 'manifest.json')).version;

fs.mkdirSync(DIST, { recursive: true });

const chromeZip = path.join(DIST, `kindling-chrome-v${VERSION}.zip`);
const firefoxZip = path.join(DIST, `kindling-firefox-v${VERSION}.zip`);

// Remove stale zips
for (const f of [chromeZip, firefoxZip]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

execSync(`zip -r "${chromeZip}" .`, { cwd: path.join(ROOT, 'extension'), stdio: 'inherit' });
execSync(`zip -r "${firefoxZip}" .`, { cwd: path.join(DIST, 'firefox'), stdio: 'inherit' });

console.log(`\nPackaged:\n  ${chromeZip}\n  ${firefoxZip}`);
