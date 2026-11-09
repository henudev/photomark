const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
async function main() {
  const dir = path.join(__dirname, '../assets');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect x="24" y="24" width="976" height="976" rx="225" fill="#2861ed"/><rect x="231" y="285" width="562" height="465" rx="71" fill="none" stroke="#fff" stroke-width="45"/><circle cx="512" cy="512" r="117" fill="none" stroke="#fff" stroke-width="45"/><path d="M357 285v-55h150v55" fill="none" stroke="#fff" stroke-width="43" stroke-linejoin="round"/><circle cx="704" cy="374" r="24" fill="#bad2ff"/><path d="m662 714 39 39 86-87" fill="none" stroke="#c7e0ff" stroke-width="33" stroke-linecap="round" stroke-linejoin="round"/></svg>');
  await sharp(svg).png().toFile(path.join(dir, 'icon.png'));
  const png = await sharp(svg).resize(256, 256).png().toBuffer();
  const header = Buffer.alloc(22); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4); header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12); header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
  await fs.writeFile(path.join(dir, 'icon.ico'), Buffer.concat([header, png]));
  if (process.platform === 'darwin') {
    const iconset = path.join(dir, 'icon.iconset'); await fs.mkdir(iconset, { recursive: true });
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) await sharp(svg).resize(size * scale).png().toFile(path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`));
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(dir, 'icon.icns')]);
    await fs.rm(iconset, { recursive: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
