import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const output = new URL('../www/', import.meta.url);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const entry of ['index.html', 'manifest.webmanifest', 'icons']) {
  await cp(new URL(entry, root), new URL(entry, output), { recursive: true });
}

const indexUrl = new URL('index.html', output);
let html = await readFile(indexUrl, 'utf8');
const cdn = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
if (!html.includes(cdn)) {
  throw new Error('Supabase CDN script tag was not found in index.html');
}
html = html.replace(cdn, './supabase.js');
html = html.replace('</head>', '  <script src="./native-voice.js"></script>\n</head>');
await writeFile(indexUrl, html);
console.log('ChatMALIK web app and native voice bridge copied into www/ for the Android build.');
