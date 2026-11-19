// Builds the static site into dist/ for GitHub Pages.
// ROPE_API_BASE (optional) is the https URL of the Rope server, e.g. https://rope-api.example.com
import { cp, rm, writeFile } from 'node:fs/promises';

const raw = (process.env.ROPE_API_BASE ?? '').trim().replace(/\/$/, '');
if (raw && !/^https:\/\/[^/\s]+(\/[^\s]*)?$/.test(raw)) {
  console.error(`ROPE_API_BASE must be an https URL, got: ${raw}`);
  process.exit(1);
}

await rm('dist', { recursive: true, force: true });
await cp('public', 'dist', { recursive: true });
await writeFile('dist/config.js', `window.ROPE_API_BASE = ${JSON.stringify(raw)};\n`);
// Stops Pages from running Jekyll, which would hide files starting with an underscore.
await writeFile('dist/.nojekyll', '');

console.log(`Built dist/ (API base: ${raw || 'same origin'})`);
