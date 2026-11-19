// Builds the static site into dist/ for GitHub Pages. There is no backend to configure.
import { cp, rm, readFile, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await cp('public', 'dist', { recursive: true });
// Stops Pages from running Jekyll, which would hide files starting with an underscore.
await writeFile('dist/.nojekyll', '');

// Stamp the page with the commit being deployed, so a phone can show which build it is running.
const build = (process.env.GITHUB_SHA ?? 'local').slice(0, 7);
const html = await readFile('dist/index.html', 'utf8');
await writeFile('dist/index.html', html.replace('__BUILD__', build));

console.log(`Built dist/ (build ${build})`);
