/** 看图:对一张图调用 OpenAI 兼容的 VLM,要一句话描述。失败都走回执,不抛。 */

export interface VisionSettings {
  enabled: boolean;
  /** OpenAI 兼容 base URL,末尾斜杠会被去掉。 */
  endpoint: string;
  apiKey: string;
  model: string;
}

export interface VisionOutcome {
  ok: boolean;
  text?: string;
  error?: string;
}

const PROMPT =
  '用一句话(不超过 40 字)描述这张图里有什么、想表达什么,给群聊接话用。不要客套,不要写"这张图片显示"。';

export async function describeImage(
  bytes: Uint8Array,
  mime: string,
  settings: VisionSettings,
  fetchImpl: typeof fetch,
  timeoutMs = 30_000,
): Promise<VisionOutcome> {
  if (!settings.enabled) return { ok: false, error: '看图没开启(worlds.netlingo.vision.enabled)' };
  const endpoint = settings.endpoint.trim().replace(/\/+$/, '');
  if (!endpoint) return { ok: false, error: '视觉端点没填(worlds.netlingo.vision.endpoint)' };
  if (!settings.model.trim()) return { ok: false, error: '视觉模型没填(worlds.netlingo.vision.model)' };
  if (!settings.apiKey) return { ok: false, error: '视觉密钥是空的,检查 .env 里那个名字' };
  if (!bytes.length) return { ok: false, error: '图片是空的' };

  const dataUrl = `data:${mime || 'image/png'};base64,${Buffer.from(bytes).toString('base64')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.apiKey}`,
        'content-type': 'application/json',
        'user-agent': 'CorticoNetlingo/0.3',
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: 160,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });

    const body = await response.text();
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}:${body.slice(0, 160)}` };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return { ok: false, error: '响应不是合法 JSON' };
    }
    const text = readContent(payload);
    if (!text) return { ok: false, error: '模型没返回文字' };
    return { ok: true, text: text.slice(0, 200) };
  } catch (err) {
    const error =
      err instanceof Error
        ? err.name === 'AbortError'
          ? '请求超时'
          : err.message
        : String(err);
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}

function readContent(payload: unknown): string {
  const root = payload as {
    choices?: Array<{ message?: { content?: unknown } }>;
  } | null;
  const content = root?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === 'object') {
          const text = (part as { text?: unknown }).text;
          if (typeof text === 'string') return text;
        }
        return '';
      })
      .join(' ')
      .trim();
  }
  return '';
}
