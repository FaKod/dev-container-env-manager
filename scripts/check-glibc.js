// Fail the build if a native module in the packaged x64 app needs a newer glibc
// than MAX_GLIBC, so an AppImage built on a new distro still starts on older
// ones. Needs objdump for x86-64 (x86_64-linux-gnu-objdump or objdump).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_GLIBC = '2.34'; // forkpty/openpty need 2.34; Ubuntu 22.04 ships 2.35
const appDir = path.join(__dirname, '../dist/linux-unpacked');

function findNodeFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return findNodeFiles(p);
    return e.name.endsWith('.node') ? [p] : [];
  });
}

function isElfX64(file) {
  const b = Buffer.alloc(20);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, b, 0, 20, 0);
  fs.closeSync(fd);
  return b.toString('latin1', 1, 4) === 'ELF' && b.readUInt16LE(18) === 0x3e;
}

function cmp(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

const objdump = ['x86_64-linux-gnu-objdump', 'objdump'].find((cmd) => {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});
if (!objdump) {
  console.warn('check-glibc: no objdump found, skipping glibc check');
  process.exit(0);
}

let failed = false;
for (const file of findNodeFiles(appDir).filter(isElfX64)) {
  const out = execFileSync(objdump, ['-T', file], { encoding: 'utf8' });
  const versions = [...new Set(out.match(/GLIBC_[0-9.]+/g) || [])].map((v) => v.slice(6));
  const max = versions.sort(cmp).pop() || 'none';
  const tooNew = max !== 'none' && cmp(max, MAX_GLIBC) > 0;
  console.log(`check-glibc: ${path.relative(appDir, file)} needs GLIBC ${max}${tooNew ? '  <-- too new' : ''}`);
  if (tooNew) failed = true;
}
if (failed) {
  console.error(`check-glibc: native modules need glibc > ${MAX_GLIBC}; see scripts/glibc-compat.h`);
  process.exit(1);
}
