// launcher/AutoTC.cs → AutoTC.exe. Windows에 기본으로 있는 .NET Framework 컴파일러(csc.exe)를 쓴다.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

if (process.platform !== 'win32') {
  console.error('AutoTC.exe 빌드는 Windows에서만 할 수 있습니다. 다른 OS에서는 npm start 로 실행하세요.');
  process.exit(1);
}

const windir = process.env.WINDIR || 'C:\\Windows';
const csc = ['Framework64', 'Framework']
  .map((f) => path.join(windir, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe'))
  .find((p) => fs.existsSync(p));
if (!csc) {
  console.error('csc.exe를 찾지 못했습니다. .NET Framework 4.x가 설치되어 있는지 확인하세요.');
  process.exit(1);
}

const out = path.join(ROOT, 'AutoTC.exe');
const r = spawnSync(csc, ['/nologo', '/codepage:65001', '/optimize+', '/target:exe', `/out:${out}`, path.join(ROOT, 'launcher', 'AutoTC.cs')], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status || 1);
console.log(`빌드 완료: ${out}`);
