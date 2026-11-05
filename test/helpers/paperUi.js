// Test helper: compile the paper app's TypeScript with Vite (the same tool that builds the shipped bundle) into one ES module
// that Node can import, React included. Nothing is written to disk.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

let cached = null;

async function loadPaperUi() {
  if (cached) return cached;
  // Vite sets NODE_ENV=production while it builds; restore it afterwards, because the server code under test reads it.
  const prevEnv = process.env.NODE_ENV;
  const { build } = await import('vite');
  const root = path.join(__dirname, '../../paper-app');
  const out = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    publicDir: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    ssr: { noExternal: true },
    build: {
      ssr: path.join(root, 'src/test-entry.ts'),
      write: false,
      minify: false,
      target: 'node22',
      rollupOptions: { output: { format: 'es', codeSplitting: false } }
    },
    plugins: [(await import('@vitejs/plugin-react')).default()]
  });
  if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
  const chunks = (Array.isArray(out) ? out : [out]).flatMap(o => o.output).filter(c => c.type === 'chunk');
  const entry = chunks.find(c => c.isEntry) || chunks[0];
  // The bundle needs a real file location (it uses import.meta.url), so it goes through the OS temp folder, outside the project.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chaindeck-paper-ui-'));
  const file = path.join(dir, 'paper-ui.mjs');
  fs.writeFileSync(file, entry.code);
  try {
    cached = await import(pathToFileURL(file).href);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return cached;
}

module.exports = { loadPaperUi };
