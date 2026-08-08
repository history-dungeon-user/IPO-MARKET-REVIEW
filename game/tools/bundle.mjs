// Bundle the whole game into ONE self-contained index-standalone.html so it can
// run as a single file (e.g. a published artifact / emailed file / mobile).
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const threeAlias = {
  name: 'three-alias',
  setup(build) {
    build.onResolve({ filter: /^three$/ }, () => ({ path: path.join(ROOT, 'vendor/three.module.js') }));
    build.onResolve({ filter: /^three\/addons\// }, (args) => ({
      path: path.join(ROOT, 'vendor/jsm', args.path.replace('three/addons/', '')),
    }));
  },
};

const result = await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/main.js')],
  bundle: true,
  format: 'iife',
  minify: true,
  legalComments: 'none',
  target: ['es2020'],
  plugins: [threeAlias],
  write: false,
});
// Escape any "</script>" that appears in a JS string literal so it can't close
// the inline <script> early. (Bundle otherwise inlined verbatim — never via
// String.replace, whose $-patterns would corrupt minified code.)
const js = result.outputFiles[0].text.replace(/<\/script>/gi, '<\\/script>');

// Everything before the import-map is the page head/body we keep as-is; drop the
// import-map + external module tag and append the self-contained bundle.
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const cut = html.indexOf('<script type="importmap">');
if (cut === -1) throw new Error('could not find import-map in index.html');
const head = html.slice(0, cut).trimEnd();
const finalHtml = `${head}\n<script>\n${js}\n</script>\n`;

const out = path.join(ROOT, 'index-standalone.html');
fs.writeFileSync(out, finalHtml);
console.log('wrote', out, '(' + (Buffer.byteLength(finalHtml) / 1024 / 1024).toFixed(2) + ' MB)');
