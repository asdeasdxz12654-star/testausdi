// 저장소에 비밀값이 평문으로 들어갔는지 검사한다 (CI와 커밋 전에 실행).
// 예) npm run scan:secrets
// 1) 알려진 키 형식(Claude·GitHub·AWS·Slack 키, 개인 키)
// 2) data/ 아래 JSON에서 이름이 password·token·secret·apiKey인데 값이 평문 문자열인 항목
//    → {"secret": "이름"}으로 바꾸고 값은 설정 → 비밀값 또는 환경변수(GitHub Secrets)로 넣는다
// 예외가 꼭 필요한 줄에는 "secret-scan:allow"를 적는다. 종료 코드: 0 문제 없음, 1 발견
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const PATTERNS = [
  { name: 'Claude API 키', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub 토큰', re: /\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/ },
  { name: 'AWS 액세스 키', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack 토큰', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Slack 웹훅', re: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/ },
  { name: '개인 키', re: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: '피그마 토큰', re: /\bfigd_[A-Za-z0-9_-]{20,}/ },
];

const SECRET_KEY = /^(pass(word)?|pw|pwd|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)$/i;

function scanText(rel, text) {
  const found = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes('secret-scan:allow')) return;
    for (const p of PATTERNS) if (p.re.test(line)) found.push({ file: rel, line: i + 1, rule: p.name });
  });
  return found;
}

// JSON 안에서 비밀값처럼 보이는 이름의 평문 값
function scanJson(rel, text) {
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  const found = [];
  const walk = (o, at) => {
    if (!o || typeof o !== 'object') return;
    // {"secret": "이름"} 참조는 값이 아니라 이름이다
    if (!Array.isArray(o) && Object.keys(o).length === 1 && typeof o.secret === 'string' && /^[A-Z][A-Z0-9_]*$/.test(o.secret)) return;
    for (const [k, v] of Object.entries(o)) {
      const here = at ? `${at}.${k}` : k;
      if (SECRET_KEY.test(k) && typeof v === 'string' && v && !/^\{\{.*\}\}$/.test(v)) {
        found.push({ file: rel, line: lineOf(text, k), rule: `평문 비밀값 (${here}) → {"secret": "이름"}으로 바꾸세요` });
      }
      walk(v, here);
    }
  };
  walk(data, '');
  return found;
}

function lineOf(text, key) {
  const i = text.indexOf(`"${key}"`);
  return i < 0 ? 1 : text.slice(0, i).split('\n').length;
}

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

function scan(files = trackedFiles(), read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')) {
  const out = [];
  for (const rel of files) {
    if (/\.(png|jpe?g|webp|gif|ico|pdf|xlsx|zip|exe|mp4|webm)$/i.test(rel) || rel.startsWith('node_modules/')) continue;
    let text;
    try { text = read(rel); } catch { continue; }
    out.push(...scanText(rel, text));
    if (rel.startsWith('data/') && rel.endsWith('.json')) out.push(...scanJson(rel, text));
  }
  return out;
}

if (require.main === module) {
  const found = scan();
  if (!found.length) {
    console.log('[secret-scan] 평문 비밀값을 찾지 못했습니다');
    process.exit(0);
  }
  console.error(`[secret-scan] ${found.length}건 발견`);
  found.forEach((f) => console.error(`  ${f.file}:${f.line}  ${f.rule}`));
  process.exit(1);
}

module.exports = { scan, scanText, scanJson };
