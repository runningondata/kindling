const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  format: 'iife',
  target: 'chrome88',
  minify: false,
  logLevel: 'info',
};

const entryPoints = [
  { entryPoints: ['src/content/kindling.js'], outfile: 'extension/content/kindling.js' },
  { entryPoints: ['src/popup/popup.js'], outfile: 'extension/popup/popup.js' },
  { entryPoints: ['src/options/options.js'], outfile: 'extension/options/options.js' },
];

async function run() {
  if (watch) {
    const contexts = await Promise.all(
      entryPoints.map(ep => esbuild.context({ ...shared, ...ep }))
    );
    await Promise.all(contexts.map(ctx => ctx.watch()));
    console.log('Watching for changes...');
  } else {
    await Promise.all(
      entryPoints.map(ep => esbuild.build({ ...shared, ...ep }))
    );
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
