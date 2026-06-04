import type { IRepoContextProvider } from '@/modules/reviews/types/repo-context-provider';
import {
  FETCH_FILE_TOOL_NAME,
  FETCH_FUNCTION_TOOL_NAME,
  FETCH_PRIOR_REVIEW_TOOL_NAME,
} from '../system-prompt';
import { formatProviderError } from './format-provider-error';

export type RunToolCallInput = {
  name: string;
  id?: string;
  input: unknown;
};

export type RunToolCallResult = {
  ok: boolean;
  text: string;
};

/**
 * Provider-neutral dispatcher for the three context-fetching tools.
 * Each adapter wraps the `{ok, text}` result into its provider-specific
 * content shape (Anthropic text-blocks; OpenRouter single string).
 *
 * Returns ok=false when the input is malformed, the repo-context layer
 * can't service the request, or no repo context was configured at all.
 * In every error path the caller continues the loop (per protocol —
 * `is_error: true` keeps the agent alive so it can either try a
 * different input or proceed to emit).
 */
export async function runToolCall(
  call: RunToolCallInput,
  repoContext: IRepoContextProvider | undefined,
): Promise<RunToolCallResult> {
  if (!repoContext) {
    return { ok: false, text: 'tool unavailable: no repo context configured' };
  }
  // Models occasionally emit `tool_calls[i].input` as a string, number,
  // or null instead of an object. Without this narrowing the
  // `as { ... }` cast below is a lie and the first property read throws —
  // landing in the catch block as a generic `tool_invocation_error`.
  // Surface a deterministic `invalid_input` instead so the agent can
  // recover on the next turn.
  const input = asRecord(call.input);
  if (!input) {
    return { ok: false, text: 'invalid_input: object expected' };
  }
  try {
    switch (call.name) {
      case FETCH_FILE_TOOL_NAME: {
        if (typeof input.path !== 'string' || input.path.length === 0) {
          return { ok: false, text: 'invalid_input: `path` expected string' };
        }
        const result = await repoContext.fetchFile(input.path);
        if (!result.ok) {
          return { ok: false, text: formatProviderError(result.reason, result.message) };
        }
        return { ok: true, text: `# ${result.path}\n\n${result.content}` };
      }

      case FETCH_FUNCTION_TOOL_NAME: {
        if (typeof input.name !== 'string' || input.name.length === 0) {
          return { ok: false, text: 'invalid_input: `name` expected string' };
        }
        if (input.file !== undefined && typeof input.file !== 'string') {
          return { ok: false, text: 'invalid_input: `file` expected string' };
        }
        const result = await repoContext.fetchFunctionDefinition(input.name, input.file);
        if (!result.ok) {
          return { ok: false, text: formatProviderError(result.reason, result.message) };
        }
        return {
          ok: true,
          text: `# ${result.path} (lines ${result.startLine}-${result.endLine})\n\n${result.content}`,
        };
      }

      case FETCH_PRIOR_REVIEW_TOOL_NAME: {
        const query: Parameters<IRepoContextProvider['fetchPriorReview']>[0] = {};
        if (input.pr_node_id !== undefined) {
          if (typeof input.pr_node_id !== 'string') {
            return { ok: false, text: 'invalid_input: `pr_node_id` expected string' };
          }
          query.pr_node_id = input.pr_node_id;
        }
        if (input.file_path !== undefined) {
          if (typeof input.file_path !== 'string') {
            return { ok: false, text: 'invalid_input: `file_path` expected string' };
          }
          query.file_path = input.file_path;
        }
        if (input.rule_id !== undefined) {
          if (typeof input.rule_id !== 'string') {
            return { ok: false, text: 'invalid_input: `rule_id` expected string' };
          }
          query.rule_id = input.rule_id;
        }
        const result = await repoContext.fetchPriorReview(query);
        if (!result.ok) {
          return { ok: false, text: formatProviderError(result.reason, result.message) };
        }
        return { ok: true, text: JSON.stringify(result.content) };
      }

      default:
        return { ok: false, text: `unknown_tool: ${call.name}` };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return { ok: false, text: `tool_invocation_error: ${msg}` };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
