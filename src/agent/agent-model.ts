// The model behind the AI agent («ИИ-агент», STAGE_WORK_MODEL §71): an OpenAI-compatible Chat Completions endpoint with tool
// calls (OpenAI, Anthropic's compatible endpoint, OpenRouter, Groq, Gemini). The agent decides what to do; tools act only in
// the throwaway sandbox. Keys stay in this process and never reach the sandbox.

/** extra: provider data that must go back with the call (Gemini 3 «thought signatures» in extra_content). */
export interface AgentToolCall { id: string; name: string; arguments: string; extra?: Record<string, unknown> }
export type AgentMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string }; extra_content?: Record<string, unknown> }> }
  | { role: 'tool'; tool_call_id: string; content: string };
export interface AgentTool { name: string; description: string; parameters: Record<string, unknown> }
export interface AgentReply { text: string | null; toolCalls: AgentToolCall[]; usage: { inputTokens: number | null; outputTokens: number | null } }

export interface AgentModel {
  readonly name: string;
  readonly model: string;
  next(messages: AgentMessage[], tools: AgentTool[]): Promise<AgentReply>;
}

export class AgentModelError extends Error {
  constructor(readonly code: 'AGENT_MODEL_UNAVAILABLE' | 'AGENT_MODEL_REJECTED' | 'AGENT_MODEL_INVALID') { super(code); }
}

type Fetch = typeof fetch;

export class ChatCompletionsAgentModel implements AgentModel {
  readonly name = 'openai-chat-tools';
  constructor(private readonly apiKey: string, readonly model: string, private readonly baseUrl: string, private readonly fetchImpl: Fetch = fetch) {}

  async next(messages: AgentMessage[], tools: AgentTool[]): Promise<AgentReply> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model, messages, tool_choice: 'auto', parallel_tool_calls: false, max_tokens: 16_000,
          tools: tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
        }),
        signal: AbortSignal.timeout(240_000),
      });
    } catch {
      throw new AgentModelError('AGENT_MODEL_UNAVAILABLE');
    }
    if (!response.ok) {
      // The status and the start of the provider's answer go to the server log, never to people: enough to see a wrong model
      // name or a request the provider does not accept. The request and the key are not logged.
      const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      console.warn(`Agent model ${this.model} answered ${response.status}: ${detail}`);
      throw new AgentModelError(response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404 ? 'AGENT_MODEL_REJECTED' : 'AGENT_MODEL_UNAVAILABLE');
    }
    let payload: { choices?: Array<{ message?: { content?: unknown; tool_calls?: Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown }; extra_content?: unknown }> } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    try { payload = await response.json(); } catch { throw new AgentModelError('AGENT_MODEL_INVALID'); }
    const message = payload.choices?.[0]?.message;
    if (!message) throw new AgentModelError('AGENT_MODEL_INVALID');
    const toolCalls = (message.tool_calls ?? []).flatMap((call, index) => {
      const name = call.function?.name;
      if (typeof name !== 'string') return [];
      const args = call.function?.arguments;
      const extra = call.extra_content && typeof call.extra_content === 'object' && !Array.isArray(call.extra_content) ? call.extra_content as Record<string, unknown> : undefined;
      return [{ id: typeof call.id === 'string' && call.id ? call.id : `call_${index}`, name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}), ...(extra ? { extra } : {}) }];
    });
    return {
      text: typeof message.content === 'string' && message.content.trim() ? message.content : null,
      toolCalls,
      usage: { inputTokens: payload.usage?.prompt_tokens ?? null, outputTokens: payload.usage?.completion_tokens ?? null },
    };
  }
}

/**
 * BUILDER_AGENT_MODEL (falls back to BUILDER_AI_OPENAI_MODEL) at the same endpoint and key as the stage AI. The agent needs a
 * model that calls tools well; a small model writes worse code, so the setting is separate.
 */
export function configuredAgentModel(env: NodeJS.ProcessEnv = process.env): AgentModel | null {
  const apiKey = env.BUILDER_AI_OPENAI_API_KEY;
  const model = env.BUILDER_AGENT_MODEL || env.BUILDER_AI_OPENAI_MODEL;
  if (!apiKey || !model) return null;
  const baseUrl = (env.BUILDER_AGENT_BASE_URL || env.BUILDER_AI_OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(`${baseUrl}/`)) return null;
  return new ChatCompletionsAgentModel(apiKey, model, baseUrl);
}
