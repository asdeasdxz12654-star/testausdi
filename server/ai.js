// Claude API 호출. 구조화 출력(JSON 스키마)으로 응답을 받고, 사용량을 돌려준다.
// API 키·피그마 토큰은 data/state/ai.json(Git 제외)에 두고, 환경변수가 있으면 그것을 쓴다.
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const P = require('./paths');
const store = require('./store');

const SETTINGS_FILE = () => path.join(P.STATE, 'ai.json');

// 1M 토큰당 달러 (Claude Opus 5.5). 화면의 예상·누적 비용 표시용
const PRICE = { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 };

function getSettings() {
  const s = store.readJson(SETTINGS_FILE(), {});
  const apiKey = process.env.ANTHROPIC_API_KEY || s.apiKey || '';
  const figmaToken = process.env.FIGMA_TOKEN || s.figmaToken || '';
  return {
    apiKey, figmaToken,
    apiKeySource: process.env.ANTHROPIC_API_KEY ? 'env' : s.apiKey ? 'saved' : null,
    figmaTokenSource: process.env.FIGMA_TOKEN ? 'env' : s.figmaToken ? 'saved' : null,
    consent: !!s.consent,
  };
}

const mask = (v) => (v ? `${v.slice(0, 7)}…${v.slice(-4)}` : '');

// 화면에 돌려줄 설정. 키 원문은 보내지 않는다
function publicSettings() {
  const s = getSettings();
  return { apiKey: mask(s.apiKey), apiKeySource: s.apiKeySource, figmaToken: mask(s.figmaToken), figmaTokenSource: s.figmaTokenSource, consent: s.consent };
}

function saveSettings(patch) {
  const cur = store.readJson(SETTINGS_FILE(), {});
  const next = { ...cur };
  if (patch.apiKey !== undefined) next.apiKey = String(patch.apiKey).trim();
  if (patch.figmaToken !== undefined) next.figmaToken = String(patch.figmaToken).trim();
  if (patch.consent !== undefined) next.consent = !!patch.consent;
  store.writeJson(SETTINGS_FILE(), next);
  return publicSettings();
}

class AiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function makeClient(apiKey) {
  if (!apiKey) throw new AiError('Claude API 키가 없습니다. 영역 매핑 → 설정에서 키를 입력하거나 ANTHROPIC_API_KEY 환경변수를 지정하세요', 400);
  return new Anthropic({ apiKey });
}

// 한 번의 요청. content는 user 메시지의 content 블록 배열
async function callJson(client, { model, effort, system, content, schema, maxTokens = 32000 }) {
  let msg;
  try {
    const stream = client.beta.messages.stream({
      model,
      max_tokens: maxTokens,
      // 안전 분류기가 거절하면 서버가 권장 모델로 다시 실행한다
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages: [{ role: 'user', content }],
      output_config: { effort, format: { type: 'json_schema', schema } },
    });
    msg = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AiError('Claude API 키가 올바르지 않습니다. 설정에서 키를 확인하세요', 401);
    if (e instanceof Anthropic.PermissionDeniedError) throw new AiError(`이 API 키로는 요청할 수 없습니다: ${e.message}`, 403);
    if (e instanceof Anthropic.RateLimitError) throw new AiError('요청 한도를 넘었습니다. 잠시 뒤 다시 시도하세요', 429);
    if (e instanceof Anthropic.BadRequestError) throw new AiError(`요청이 거부되었습니다: ${e.message}`, 400);
    // APIConnectionError도 APIError의 하위 클래스라 먼저 검사한다
    if (e instanceof Anthropic.APIConnectionError) throw new AiError(`Claude API에 연결하지 못했습니다: ${e.message}`, 502);
    if (e instanceof Anthropic.APIError) throw new AiError(`Claude API 오류 (${e.status}): ${e.message}`, 502);
    throw e;
  }
  if (msg.stop_reason === 'refusal') {
    const d = msg.stop_details;
    throw new AiError(`Claude가 이 요청을 처리하지 않았습니다${d && d.category ? ` (${d.category})` : ''}. 자료에 민감한 내용이 있는지 확인하세요`, 422);
  }
  if (msg.stop_reason === 'max_tokens') throw new AiError('응답이 길어 중간에 끊겼습니다. TC를 나눠서 분석하세요', 502);
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AiError('Claude 응답을 해석하지 못했습니다', 502);
  }
  return { data, usage: msg.usage || {}, model: msg.model };
}

function addUsage(total, usage) {
  const t = total || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, calls: 0 };
  t.input += usage.input_tokens || 0;
  t.output += usage.output_tokens || 0;
  t.cacheWrite += usage.cache_creation_input_tokens || 0;
  t.cacheRead += usage.cache_read_input_tokens || 0;
  t.calls += 1;
  return t;
}

function costUsd(t) {
  if (!t) return 0;
  return (t.input * PRICE.input + t.output * PRICE.output + t.cacheWrite * PRICE.cacheWrite + t.cacheRead * PRICE.cacheRead) / 1e6;
}

module.exports = { getSettings, publicSettings, saveSettings, makeClient, callJson, addUsage, costUsd, AiError, PRICE };
