#!/usr/bin/env node
// ============================================================================
// Kindling — Firefox Build Script
// ============================================================================
// Produces a Firefox-compatible extension in dist/firefox/ from the shared
// source in extension/. The only difference is the manifest.json, which uses
// "scripts" instead of "service_worker" in the background section for
// compatibility with Firefox versions prior to 120.
//
// Usage:
//   node scripts/build-firefox.js
//
// Output:
//   dist/firefox/   — ready to load via about:debugging or package for AMO
// ============================================================================

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.resolve(__dirname, '..', 'extension');
const DIST_DIR = path.resolve(__dirname, '..', 'dist', 'firefox');

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 1. Copy entire extension directory
if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
}
copyDirSync(SRC_DIR, DIST_DIR);

// 2. Read and modify manifest for Firefox
const manifestPath = path.join(DIST_DIR, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// Firefox < 120 uses "scripts" array instead of "service_worker" string
if (manifest.background && manifest.background.service_worker) {
  const workerScript = manifest.background.service_worker;
  manifest.background = {
    scripts: [workerScript],
  };
}

// Ensure browser_specific_settings is present
if (!manifest.browser_specific_settings) {
  manifest.browser_specific_settings = {
    gecko: {
      id: 'kindling@kindling-spark-diagnostics',
      strict_min_version: '109.0',
    },
  };
}

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log('Firefox extension built at: ' + DIST_DIR);
console.log('');
console.log('To test:');
console.log('  1. Open Firefox and navigate to about:debugging#/runtime/this-firefox');
console.log('  2. Click "Load Temporary Add-on..."');
console.log('  3. Select dist/firefox/manifest.json');
console.log('');
console.log('To publish on AMO:');
console.log('  1. Zip the contents of dist/firefox/');
console.log('  2. Submit at https://addons.mozilla.org/developers/');
