const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
async function createDemo(directory = path.join(__dirname, '../demo-photos')) {
  await fs.mkdir(directory, { recursive: true });
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600" viewBox="0 0 1200 800">
  <defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#aabccc"/><stop offset=".6" stop-color="#e1c4ac"/><stop offset="1" stop-color="#f8c69e"/></linearGradient><linearGradient id="lake" x2="0" y2="1"><stop stop-color="#799da8"/><stop offset="1" stop-color="#1e5465"/></linearGradient><radialGradient id="glow"><stop stop-color="#ffdea7" stop-opacity=".8"/><stop offset="1" stop-color="#ffdea7" stop-opacity="0"/></radialGradient></defs>
  <rect width="1200" height="800" fill="url(#sky)"/><circle cx="830" cy="307" r="240" fill="url(#glow)"/><circle cx="830" cy="307" r="33" fill="#ffe1a9"/>
  <path d="M0 390 145 270 236 352 379 202 512 355 635 286 774 402 943 291 1200 395V650H0Z" fill="#91a4a9"/>
  <path d="m0 455 130-84 154 71 160-130 151 123 162-52 180 82 143-93 120 57v300H0Z" fill="#617f88"/>
  <path d="M0 485 Q300 455 600 486T1200 478V800H0Z" fill="url(#lake)"/>
  <path d="M650 510h330m-355 24h370m-300 31h250m-225 40h190m-170 50h150m-125 51h90" stroke="#edc6a2" stroke-width="3" opacity=".35"/>
  <path d="m0 507 85-10 132 77 95 60 100 48 112 118H0Z" fill="#214c51"/><path d="m0 560 146 40 48 82 122 22 48 96H0Z" fill="#173b40"/>
  <g stroke="#183e43" fill="#183e43"><path d="M76 505V276m0 15-37 73h74Zm0 35-51 88h106Zm0 51-66 104h132Z"/><path d="M148 543V365m0 4-32 68h64Zm0 31-45 87h90Zm0 44-54 92h108Z"/></g>
  <g stroke="#b0c9c9" opacity=".17"><path d="M523 720h219m82-160h220M370 575h120m405 143h244M588 621h120m-330 122h104M1005 644h120"/></g>
  </svg>`);
  const base = path.join(directory, 'IMG_20261109_143025.jpg');
  await sharp(svg).jpeg({ quality: 96 }).withExif({ IFD0: { Make: 'PhotoMark', Model: '演示图像（非真实照片）' }, IFD2: { DateTimeOriginal: '2026:11:09 14:30:25' } }).withIccProfile('srgb').toFile(base);
  await sharp(svg).flop().jpeg({ quality: 96 }).withExif({ IFD2: { DateTimeOriginal: '2026:11:08 18:06:12' } }).toFile(path.join(directory, 'IMG_20261108_180612.jpg'));
  return directory;
}
if (require.main === module) createDemo().then(console.log).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { createDemo };
