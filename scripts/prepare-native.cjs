const { spawnSync } = require('node:child_process');
// sharp provides prebuilt modules; include Apple Silicon Mac and Windows x64
// explicitly when cross-packaging. npm otherwise installs host-only optional deps.
const packages = ['@img/sharp-darwin-arm64@0.35.5', '@img/sharp-libvips-darwin-arm64@1.3.4', '@img/sharp-win32-x64@0.35.5'];
if (process.platform !== 'darwin') {
  console.log('原生平台构建：使用 npm ci 安装的 sharp 模块');
} else {
  const result = spawnSync('npm', ['install', '--no-save', '--force', '--ignore-scripts', ...packages], { stdio: 'inherit', shell: false });
  process.exitCode = result.status || 0;
}
