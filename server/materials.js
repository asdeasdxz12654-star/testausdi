// 기획서·화면 디자인 자료. 영역 매핑과 TC 자동 작성이 같은 방식으로 프로젝트 폴더에 저장한다.
// p.specs: [{ id: S1, name, kind: pdf|image|text, file, size, text? }], p.frames: [{ id: F1, name, file, source, texts?, nodes? }]
const fs = require('fs');
const path = require('path');
const { HttpError } = require('./store');

const SPEC_KINDS = { '.pdf': 'pdf', '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.txt': 'text', '.md': 'text' };
const MEDIA = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf' };

function nextId(list, prefix) {
  const n = list.reduce((m, x) => Math.max(m, Number(String(x.id).slice(prefix.length)) || 0), 0);
  return `${prefix}${n + 1}`;
}

// dir: 프로젝트 폴더. p를 고치고 저장은 호출한 쪽이 한다
function addFile(dir, p, { kind, fileName, data }) {
  const ext = path.extname(fileName || '').toLowerCase();
  const buf = Buffer.from(data || '', 'base64');
  if (!buf.length) throw new HttpError(400, '빈 파일입니다');
  if (kind === 'spec') {
    if (!SPEC_KINDS[ext]) throw new HttpError(400, '기획서는 PDF, 이미지(PNG/JPG/WEBP), 텍스트(.txt/.md)만 올릴 수 있습니다. PPT·워드는 PDF로 저장해 올려 주세요');
    if (ext === '.pdf' && buf.length > 30 * 1024 * 1024) throw new HttpError(400, 'PDF가 너무 큽니다 (최대 30MB)');
    const sid = nextId(p.specs, 'S');
    const file = `specs/${sid}${ext}`;
    fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
    fs.writeFileSync(path.join(dir, file), buf);
    const spec = { id: sid, name: fileName, kind: SPEC_KINDS[ext], file, size: buf.length };
    if (spec.kind === 'text') spec.text = buf.toString('utf8').replace(/^﻿/, '');
    p.specs.push(spec);
  } else if (kind === 'frame') {
    if (!MEDIA[ext] || ext === '.pdf') throw new HttpError(400, '디자인은 프레임을 PNG/JPG/WEBP로 내보내 올려 주세요');
    if (buf.length > 5 * 1024 * 1024) throw new HttpError(400, '이미지가 너무 큽니다 (최대 5MB). 피그마에서 1x로 내보내 주세요');
    const fid = nextId(p.frames, 'F');
    const file = `frames/${fid}${ext}`;
    fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
    fs.writeFileSync(path.join(dir, file), buf);
    p.frames.push({ id: fid, name: path.basename(fileName, ext), file, source: 'upload', texts: null });
  } else {
    throw new HttpError(400, 'kind는 spec 또는 frame이어야 합니다');
  }
  return p;
}

async function addFigma(dir, p, url, { figma = require('./figma'), token, figmaOptions } = {}) {
  const got = await figma.fetchFrames(url, token, figmaOptions);
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  for (const f of got.frames) {
    const fid = nextId(p.frames, 'F');
    const file = `frames/${fid}.png`;
    fs.writeFileSync(path.join(dir, file), f.png);
    p.frames.push({ id: fid, name: f.name, file, source: 'figma', figmaId: f.figmaId, width: f.width, height: f.height, texts: f.texts, nodes: f.nodes || [] });
  }
  p.figma = { url: String(url).trim(), fileKey: got.fileKey };
  return { added: got.frames.length, skipped: got.skipped };
}

// 지운 자료를 돌려준다
function removeFile(dir, p, fileId) {
  const list = String(fileId).startsWith('S') ? p.specs : p.frames;
  const item = list.find((x) => x.id === fileId);
  if (!item) throw new HttpError(404, `자료를 찾을 수 없습니다: ${fileId}`);
  list.splice(list.indexOf(item), 1);
  fs.rmSync(path.join(dir, item.file), { force: true });
  return item;
}

module.exports = { SPEC_KINDS, MEDIA, nextId, addFile, addFigma, removeFile };
