// 피그마 REST API로 프레임 목록, 프레임 이미지(PNG), 텍스트 레이어(문구·좌표)를 가져온다.
// 개인 액세스 토큰(Settings → Security → Personal access tokens, file_content:read)이 필요하다.
const API = 'https://api.figma.com/v1';

const fail = (status, message) => Object.assign(new Error(message), { status });

function parseFigmaUrl(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { return null; }
  if (!/(^|\.)figma\.com$/.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/(?:design|file|proto)\/([a-zA-Z0-9]+)(?:\/branch\/([a-zA-Z0-9]+))?/);
  if (!m) return null;
  const nodeId = u.searchParams.get('node-id');
  return { fileKey: m[2] || m[1], nodeId: nodeId ? nodeId.replace(/-/g, ':') : null };
}

async function getJson(fetchImpl, url, token) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { 'X-Figma-Token': token }, signal: AbortSignal.timeout(60000) });
  } catch (e) {
    throw fail(502, `피그마에 접속하지 못했습니다: ${e.cause ? e.cause.code || e.cause.message : e.message}`);
  }
  if (res.status === 403) throw fail(403, '피그마 토큰이 올바르지 않거나 이 파일을 볼 권한이 없습니다');
  if (res.status === 404) throw fail(404, '피그마 파일을 찾을 수 없습니다. 링크를 확인하세요');
  if (res.status === 429) throw fail(429, '피그마 요청 한도를 넘었습니다. 잠시 뒤 다시 시도하세요');
  if (!res.ok) throw fail(502, `피그마 API 오류 (HTTP ${res.status})`);
  return res.json();
}

// 프레임 안의 TEXT 노드를 모아 프레임 기준 0~1 좌표로 바꾼다
function collectTexts(frame) {
  const fb = frame.absoluteBoundingBox;
  const out = [];
  const walk = (n) => {
    if (n.visible === false) return;
    if (n.type === 'TEXT' && n.characters && n.absoluteBoundingBox && fb) {
      const b = n.absoluteBoundingBox;
      out.push({
        text: n.characters.trim(),
        layer: n.name,
        box: [(b.x - fb.x) / fb.width, (b.y - fb.y) / fb.height, b.width / fb.width, b.height / fb.height].map((v) => Math.round(v * 1000) / 1000),
      });
    }
    (n.children || []).forEach(walk);
  };
  walk(frame);
  return out.filter((t) => t.text);
}

// 링크에 node-id가 있으면 그 노드(프레임이면 그 자체, 섹션·페이지면 안의 프레임들), 없으면 첫 페이지의 최상위 프레임들
async function fetchFrames(url, token, { fetchImpl = fetch, maxFrames = 30 } = {}) {
  const ref = parseFigmaUrl(url);
  if (!ref) throw fail(400, '피그마 링크가 아닙니다. https://www.figma.com/design/... 형식의 링크를 붙여넣으세요');
  if (!token) throw fail(400, '피그마 토큰이 없습니다. 설정에서 개인 액세스 토큰을 입력하거나, 프레임을 PNG로 내보내 캡처로 올리세요');
  let frames;
  if (ref.nodeId) {
    const data = await getJson(fetchImpl, `${API}/files/${ref.fileKey}/nodes?ids=${encodeURIComponent(ref.nodeId)}`, token);
    const node = data.nodes && data.nodes[ref.nodeId] && data.nodes[ref.nodeId].document;
    if (!node) throw fail(404, '링크의 노드를 찾을 수 없습니다');
    frames = node.type === 'FRAME' || node.type === 'COMPONENT' ? [node] : (node.children || []).filter((c) => c.type === 'FRAME');
  } else {
    const data = await getJson(fetchImpl, `${API}/files/${ref.fileKey}`, token);
    const page = (data.document.children || [])[0];
    frames = page ? (page.children || []).filter((c) => c.type === 'FRAME') : [];
  }
  if (!frames.length) throw fail(400, '가져올 프레임이 없습니다. 화면 프레임이나 그 프레임을 담은 섹션의 링크를 붙여넣으세요');
  const skipped = Math.max(0, frames.length - maxFrames);
  frames = frames.slice(0, maxFrames);
  const ids = frames.map((f) => f.id).join(',');
  const imgs = await getJson(fetchImpl, `${API}/images/${ref.fileKey}?ids=${encodeURIComponent(ids)}&format=png&scale=1`, token);
  const out = [];
  for (const f of frames) {
    const src = imgs.images && imgs.images[f.id];
    if (!src) continue;
    let res;
    try {
      res = await fetchImpl(src, { signal: AbortSignal.timeout(60000) });
    } catch (e) {
      throw fail(502, `프레임 이미지를 받지 못했습니다 (${f.name}): ${e.message}`);
    }
    if (!res.ok) throw fail(502, `프레임 이미지를 받지 못했습니다 (${f.name}, HTTP ${res.status})`);
    out.push({
      name: f.name,
      figmaId: f.id,
      width: Math.round(f.absoluteBoundingBox ? f.absoluteBoundingBox.width : 0),
      height: Math.round(f.absoluteBoundingBox ? f.absoluteBoundingBox.height : 0),
      png: Buffer.from(await res.arrayBuffer()),
      texts: collectTexts(f),
    });
  }
  return { fileKey: ref.fileKey, frames: out, skipped };
}

module.exports = { parseFigmaUrl, collectTexts, fetchFrames };
