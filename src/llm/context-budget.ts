import type { ModelMessage } from 'ai';

export class ContextBudgetError extends Error {}

export function contextLimits() {
  const configured = Number(process.env.AI_CONTEXT_TOKENS ?? process.env.OLLAMA_NUM_CTX ?? 8192);
  const contextSize = Number.isInteger(configured) && configured > 0 ? configured : 8192;
  const prediction = Number(process.env.AI_MAX_OUTPUT_TOKENS ?? process.env.OLLAMA_NUM_PREDICT ?? 1024);
  const predictionLimit = Math.min(
    Number.isInteger(prediction) && prediction > 0 ? prediction : 1024,
    Math.max(1, Math.floor(contextSize / 4)),
  );
  // Approximation across tokenizers; leave additional room for chat templates.
  const ceiling = Math.max(0, (contextSize - predictionLimit - 512) * 3);
  const configuredLimit = Number(process.env.CONTEXT_CHAR_LIMIT);
  const characterLimit =
    Number.isInteger(configuredLimit) && configuredLimit > 0
      ? Math.min(configuredLimit, ceiling)
      : ceiling;
  return { contextSize, predictionLimit, characterLimit };
}

export function isContextOverflow(error: unknown): boolean {
  return (
    error instanceof Error &&
    /context.{0,60}(exceed|full|overflow|too (?:long|large)|limit)|(?:input|prompt).{0,60}(too (?:long|large)|exceed)|exceed.{0,60}context/i.test(
      error.message,
    )
  );
}

export function boundedToolResult(result: unknown, limit = 4000): string {
  const json = JSON.stringify(result) ?? 'null';
  if (json.length <= limit) return json;
  const value = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  const summary: Record<string, unknown> = { truncated: true };
  for (const key of ['tool', 'ok', 'id', 'messageId']) {
    if (typeof value[key] === 'boolean') summary[key] = value[key];
    else if (typeof value[key] === 'string') summary[key] = value[key].slice(0, 100);
  }
  summary.preview = json.slice(0, Math.max(0, Math.floor((limit - 800) / 6)));
  return JSON.stringify(summary);
}

// UTF-8 bytes conservatively account for non-ASCII text; images have a separate estimate.
export function fitContext(messages: ModelMessage[], limit: number, toolCharacters: number): ModelMessage[] {
  const system: ModelMessage[] = [];
  const groups: ModelMessage[][] = [];
  for (const message of messages) {
    const copy = { ...message } as ModelMessage;
    if (copy.role === 'system') {
      copy.content = copy.content.replace(/\nSome older context was omitted to fit the context budget\.$/, '');
      system.push(copy);
    }
    else groups.push([copy]);
  }
  const newestUser = groups.findLast((group) => group[0]?.role === 'user');
  // Binary/base64 bytes are not text tokens. Reserve an estimate per image instead.
  const size = () => {
    const current = [...system, ...groups.flat()];
    return (
      toolCharacters +
      Buffer.byteLength(
        JSON.stringify(current, (key, value: unknown) => (key === 'images' ? undefined : value)),
      ) +
      current.reduce(
        (total, message) =>
          total +
          (Array.isArray(message.content)
            ? message.content.filter((part) => part.type === 'image').length * 2048
            : 0),
        0,
      )
    );
  };
  const budget = limit - 80;
  let omitted = false;
  while (size() > budget) {
    const removable = groups.findIndex(
      (group, index) => group !== newestUser && index < groups.length - 1,
    );
    if (removable < 0) break;
    groups.splice(removable, 1);
    omitted = true;
  }
  // Catalogs and retrieved facts are expendable; identity and core rules are not.
  for (const message of system) {
    if (size() <= budget) break;
    const start = message.content.lastIndexOf('\n\n<reference_context>\n');
    if (start >= 0 && message.content.endsWith('\n</reference_context>')) {
      message.content = message.content.slice(0, start);
      omitted = true;
    }
  }
  for (const message of groups
    .flat()
    .filter((message) => message.role !== 'tool' && typeof message.content === 'string')
    .sort((left, right) => (typeof right.content === 'string' ? right.content.length : 0) - (typeof left.content === 'string' ? left.content.length : 0))) {
    while (size() > budget && typeof message.content === 'string' && message.content.length > 256) {
      const length = Math.max(128, Math.floor(message.content.length / 2));
      message.content = `${message.content.slice(0, Math.floor(length / 2))}\n[Content truncated; use history or lookup tools for details.]\n${message.content.slice(-Math.floor(length / 2))}`;
      omitted = true;
    }
  }
  for (const message of groups.flat().filter((message) => message.role === 'user')) {
    if (size() <= budget) break;
    if (Array.isArray(message.content) && message.content.some((part) => part.type === 'image')) {
      message.content = [
        ...message.content.filter((part) => part.type !== 'image'),
        { type: 'text', text: '[Images omitted to fit context; no image pixels are available for this message.]' },
      ];
      omitted = true;
    }
  }
  if (omitted && system[0])
    system[0].content += '\nSome older context was omitted to fit the context budget.';
  if (size() > limit) {
    throw new ContextBudgetError(
      'Core instructions and current tool exchange exceed CONTEXT_CHAR_LIMIT. Increase the limit/AI_CONTEXT_TOKENS or shorten custom instructions.',
    );
  }
  return [...system, ...groups.flat()];
}
