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
  /** Retries after a timeout, a lost connection or a busy provider (429/5xx) for about four minutes: overload spikes of free models
   * usually pass by then. */
  constructor(private readonly apiKey: string, readonly model: string, private readonly baseUrl: string, private readonly fetchImpl: Fetch = fetch, private readonly options: { reasoningEffort?: string; retryDelaysMs?: number[]; timeoutMs?: number } = {}) {}

  async next(messages: AgentMessage[], tools: AgentTool[]): Promise<AgentReply> {
    const delays = this.options.retryDelaysMs ?? [15_000, 30_000, 60_000, 120_000];
    const body = JSON.stringify({
      model: this.model, messages, tool_choice: 'auto', parallel_tool_calls: false, max_tokens: 16_000,
      ...(this.options.reasoningEffort ? { reasoning_effort: this.options.reasoningEffort } : {}),
      tools: tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
    });
    let response: Response | null = null;
    for (let attempt = 0; ; attempt += 1) {
      let failure: string;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 240_000),
        });
        if (response.ok || ![408, 429, 500, 502, 503, 504].includes(response.status)) break;
        failure = `answered ${response.status}: ${(await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)}`;
        response = null;
      } catch (error) {
        failure = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'did not answer in time' : 'could not be reached';
      }
      // The reason goes to the server log, never to people; the request and the key are not logged.
      console.warn(`Agent model ${this.model} ${failure} (attempt ${attempt + 1} of ${delays.length + 1})`);
      if (attempt >= delays.length) throw new AgentModelError('AGENT_MODEL_UNAVAILABLE');
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
    if (!response.ok) {
      // The status and the start of the provider's answer go to the server log, never to people: enough to see a wrong model
      // name or a request the provider does not accept. The request and the key are not logged.
      const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      console.warn(`Agent model ${this.model} answered ${response.status}: ${detail}`);
      throw new AgentModelError('AGENT_MODEL_REJECTED');
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
 * BUILDER_AGENT_MODEL (falls back to BUILDER_AI_OPENAI_MODEL). The endpoint and key are the stage AI's unless
 * BUILDER_AGENT_BASE_URL / BUILDER_AGENT_API_KEY name another provider (for example Groq when free Gemini is overloaded). The agent needs a
 * model that calls tools well; a small model writes worse code, so the setting is separate.
 */
export function configuredAgentModel(env: NodeJS.ProcessEnv = process.env): AgentModel | null {
  const apiKey = env.BUILDER_AGENT_API_KEY || env.BUILDER_AI_OPENAI_API_KEY;
  const model = env.BUILDER_AGENT_MODEL || env.BUILDER_AI_OPENAI_MODEL;
  if (!apiKey || !model) return null;
  const baseUrl = (env.BUILDER_AGENT_BASE_URL || env.BUILDER_AI_OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(`${baseUrl}/`)) return null;
  const effort = env.BUILDER_AGENT_REASONING_EFFORT;
  return new ChatCompletionsAgentModel(apiKey, model, baseUrl, fetch, effort && ['none', 'minimal', 'low', 'medium', 'high'].includes(effort) ? { reasoningEffort: effort } : {});
}
