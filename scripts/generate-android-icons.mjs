import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const root = new URL('../', import.meta.url);
const svg = await (await import('node:fs/promises')).readFile(new URL('../icons/icon.svg', import.meta.url));
const androidRes = new URL('../android/app/src/main/res/', import.meta.url);

const densities = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192]
];

for (const [density, size] of densities) {
  const dir = new URL(`mipmap-${density}/`, androidRes);
  await mkdir(dir, { recursive: true });
  const png = await sharp(svg).resize(size, size).png().toBuffer();
  await writeFile(new URL('ic_launcher.png', dir), png);
  await writeFile(new URL('ic_launcher_round.png', dir), png);
}

// Android 8+ adaptive launcher icon: Android applies the device's own mask.
const foregroundDir = new URL('mipmap-xxxhdpi/', androidRes);
const foregroundSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<defs><linearGradient id="fg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#174F91"/><stop offset="1" stop-color="#04152D"/></linearGradient></defs>
<rect x="56" y="56" width="400" height="400" rx="112" fill="url(#fg)" stroke="#75B8F0" stroke-width="10"/>
<path d="M118 150c0-25 20-45 45-45h186c25 0 45 20 45 45v151c0 25-20 45-45 45H232l-79 62v-62h-10c-25 0-45-20-45-45V150z" fill="#0A2343" stroke="#75B8F0" stroke-width="12" stroke-linejoin="round"/>
<path d="M151 290V169h35l70 82 70-82h35v121h-39v-62l-66 75-66-75v62z" fill="#DDF1FF"/>
<circle cx="365" cy="365" r="27" fill="#62B8FF" stroke="#DDF1FF" stroke-width="8"/>
</svg>`);
const adaptivePng = await sharp(foregroundSvg).resize(432, 432).png().toBuffer();
await writeFile(new URL('chatmalik_foreground.png', foregroundDir), adaptivePng);

const v26 = new URL('mipmap-anydpi-v26/', androidRes);
await mkdir(v26, { recursive: true });
const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/chatmalik_launcher_background"/>
    <foreground android:drawable="@mipmap/chatmalik_foreground"/>
</adaptive-icon>`;
await writeFile(new URL('ic_launcher.xml', v26), adaptive);
await writeFile(new URL('ic_launcher_round.xml', v26), adaptive);

const values = new URL('values/', androidRes);
await mkdir(values, { recursive: true });
await writeFile(new URL('chatmalik_launcher_colors.xml', values), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="chatmalik_launcher_background">#061A35</color>
</resources>`);
console.log('Generated ChatMALIK dark-blue Android launcher icons for all densities and adaptive icons.');
