// Builds the static site into dist/ for GitHub Pages. There is no backend to configure.
import { cp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

await rm('dist', { recursive: true, force: true });
await cp('public', 'dist', { recursive: true });
// Stops Pages from running Jekyll, which would hide files starting with an underscore.
await writeFile('dist/.nojekyll', '');

// Stamp the page with the commit being deployed, so a phone can show which build it is running.
const build = (process.env.GITHUB_SHA ?? 'local').slice(0, 7);
const html = await readFile('dist/index.html', 'utf8');
await writeFile('dist/index.html', html.replace('__BUILD__', build));

// The service worker keeps the app's files for offline use: give it this build's name and file list.
async function files(dir, base = '') {
  const out = [];
  for (const e of await readdir(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await files(dir, rel)));
    else out.push(rel);
  }
  return out;
}
// The ship inspector (with three.js, ~0.7 MB) is left out: it is saved the first time someone opens it,
// so phones that only use the map never download it.
const onDemand = (f) => f.startsWith('ships/') || f === 'vendor/three.js';
const precache = ['./', ...(await files('dist')).filter((f) => f !== 'sw.js' && f !== '.nojekyll' && f !== 'index.html' && !onDemand(f)).sort()];
const sw = await readFile('dist/sw.js', 'utf8');
await writeFile('dist/sw.js', sw
  .replace("'__BUILD__'", JSON.stringify(build))
  .replace(/\/\*PRECACHE\*\/.*?\/\*END\*\//s, JSON.stringify(precache)));

console.log(`Built dist/ (build ${build}, ${precache.length} files kept for offline use)`);
