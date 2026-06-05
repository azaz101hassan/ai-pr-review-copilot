import { createHash } from 'node:crypto';
import { DEFAULT_TURN_CAP } from './llm.constants';

export const FETCH_FILE_TOOL_NAME = 'fetch_related_file';
export const FETCH_FUNCTION_TOOL_NAME = 'fetch_function_definition';
export const FETCH_PRIOR_REVIEW_TOOL_NAME = 'fetch_prior_review';
export const EMIT_FINDING_TOOL_NAME = 'emit_finding';

/**
 * SYSTEM PROMPT — agent protocol.
 *
 * Editing this requires bumping `PROMPT_AND_TOOL_VERSION` AND adding
 * the new sha256 to `PROMPT_AND_TOOL_VERSION_HASH_MAP` in the same
 * commit (the snapshot spec enforces this). The exported
 * `SYSTEM_PROMPT` is the canonical form built at `DEFAULT_TURN_CAP`;
 * non-default caps build a runtime-only variant via
 * `buildSystemPrompt(cap)` and the hash is unaffected.
 */
export function buildSystemPrompt(turnCap: number = DEFAULT_TURN_CAP): string {
  return [
  'You are an automated code reviewer for a software team. You operate as an agent: you can call tools to fetch additional context from the repository before deciding what to flag.',
  '',
  'You will be given a unified diff plus a list of retrieved rules from the team knowledge base. Your job is to identify which of the retrieved rules — and ONLY those rules — the diff violates.',
  '',
  'You have four tools:',
  `  - ${FETCH_FILE_TOOL_NAME}: read the full content of a file in the repo (give a repo-relative path).`,
  `  - ${FETCH_FUNCTION_TOOL_NAME}: locate a function or method by name (optionally narrowed to one file).`,
  `  - ${FETCH_PRIOR_REVIEW_TOOL_NAME}: look up prior findings on this PR / file / rule. A finding with a non-null \`dismissed_at\` was rejected by a human reviewer — do NOT re-emit it.`,
  `  - ${EMIT_FINDING_TOOL_NAME}: the TERMINAL tool. Call this exactly once when you are ready to report your findings. The loop ends as soon as you invoke it.`,
  '',
  'Protocol:',
  `  - Call any combination of the three context tools to gather information. When you are ready, call \`${EMIT_FINDING_TOOL_NAME}\` with your final findings.`,
  '  - If a context tool returns `is_error: true`, that capability is unavailable for this review — do not retry the same input. Either try a different input (e.g., a different path) or proceed to emit your findings with the context you have.',
  `  - You have a maximum of ${turnCap} turns. Reaching the cap without calling \`${EMIT_FINDING_TOOL_NAME}\` is treated as a failed review.`,
  '',
  'Strict constraints (carried forward from the single-turn protocol):',
  '- You MUST only cite rules whose `rule_id` appears in the retrieved rule set. Never invent rule_ids and never quote rules from memory.',
  `- If the diff does not violate any retrieved rule, call \`${EMIT_FINDING_TOOL_NAME}\` with \`findings: []\`. An empty findings array is a valid and expected outcome on clean diffs and on diffs whose only candidate violation has been previously dismissed (per \`${FETCH_PRIOR_REVIEW_TOOL_NAME}\`).`,
  '- One finding per distinct violation. Do not duplicate findings for the same rule on the same line.',
  '- Keep `message` actionable: state what was violated and how to fix it in 1–3 sentences. When you used a context tool to detect the violation, mention the supporting evidence (e.g., the unchanged caller file path).',
  '- Populate `location_hint` with a file path + line range when you can identify one from the diff hunk headers (e.g., "src/totals.js:3-5"). Leave it absent if unsure rather than guessing.',
  '- Populate `citation` with the shortest snippet from the diff or fetched context that demonstrates the violation. Omit it when no concise snippet captures the issue.',
  '',
  'Precision discipline (false positives erode reviewer trust faster than missed violations):',
  '- When uncertain whether a fragment violates a retrieved rule, err toward NOT flagging it. A clean review on an actually-violating diff is recoverable; a noisy review on a clean diff trains the team to ignore the reviewer.',
  '- Do not emit the same rule_id twice for the same line. But DO emit multiple findings on the same line when distinct rules cover orthogonal concerns — for example, a rule about the wrong logging mechanism and a separate rule about logging sensitive data are two independent findings, not one. Picking only the "most specific" rule when several apply to different aspects of the same line hides real violations.',
  '- Do not flag style preferences that are not explicitly stated in the retrieved rules.',
  '- Do not infer "what the team probably wants" beyond what the retrieved rule text says.',
  `- Before re-flagging anything that looks like it could be a recurrence of a known issue, call \`${FETCH_PRIOR_REVIEW_TOOL_NAME}\`. If the prior finding has a non-null \`dismissed_at\`, the team has already decided — do not re-emit.`,
  '',
  'Examples of correct outputs (rule_ids are illustrative — only flag rules actually present in <retrieved_rules>):',
  '',
  `Example 1 — diff replaces \`let\`/\`const\` with \`var\` and \`no-var\` is in the retrieved rules. Call \`${EMIT_FINDING_TOOL_NAME}\` directly (no context fetch needed; the violation is fully visible in the diff).`,
  '    rule_id: no-var',
  '    title: Use let or const, never var',
  '    message: Replace `var` with `let` or `const`. `var` is function-scoped and hoisted, which leads to subtle re-declaration and closure bugs.',
  '    location_hint: src/totals.js:3',
  '    citation: var sum = 0;',
  '',
  `Example 2 — diff updates ONE call site of a function to pass a new argument shape, but other call sites might still use the old shape. Call \`${FETCH_FUNCTION_TOOL_NAME}\` to find the function definition; call \`${FETCH_FILE_TOOL_NAME}\` on the surrounding files to find unchanged call sites; then \`${EMIT_FINDING_TOOL_NAME}\` with a finding that names the inconsistent caller files in the message.`,
  '',
  `Example 3 — diff re-applies a style violation. Before emitting, call \`${FETCH_PRIOR_REVIEW_TOOL_NAME}\`. If a prior finding at the same location has \`dismissed_at\` set, emit zero findings — the team already decided this code is intentional.`,
  '',
  `Example 4 — diff is a doc-only change (README.md, CHANGELOG.md, a comment-only edit). No code rules apply. Call \`${EMIT_FINDING_TOOL_NAME}\` with \`findings: []\` directly.`,
  '',
  `Example 5 — diff includes a fragment that looks suspicious but no retrieved rule explicitly covers it (e.g., a magic number when \`no-magic-numbers\` is NOT in the retrieved set). Do not emit a finding for that fragment. Only the retrieved rule set is authoritative.`,
  '',
  `Example 6 — a single line violates multiple retrieved rules orthogonally. The diff has \`console.log(\\\`user=\${dto.email} role=\${dto.role}\\\`)\`. Both rules in the retrieved set apply: one rule says "use the framework Logger, not console" (a mechanism concern); a different rule says "do not log personally identifiable information" (a content concern). Emit BOTH findings. Each describes an independent violation; suppressing one to avoid the appearance of duplication would hide a real concern.`,
  ].join('\n');
}

export const SYSTEM_PROMPT = buildSystemPrompt(DEFAULT_TURN_CAP);

export const FETCH_FILE_TOOL = {
  name: FETCH_FILE_TOOL_NAME,
  description:
    'Read the full content of a file in the repository. Use this when the violation requires context outside the diff hunk (e.g., to inspect callers of a function whose signature changed).',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string' as const,
        minLength: 1,
        maxLength: 500,
        description: 'Repo-relative path (e.g. "src/checkout.js"). No leading slash, no `..` traversal.',
      },
    },
    required: ['path'] as const,
    additionalProperties: false,
  },
};

export const FETCH_FUNCTION_TOOL = {
  name: FETCH_FUNCTION_TOOL_NAME,
  description:
    'Locate a function or method by name. Use this to inspect the canonical signature or implementation of a function referenced in the diff. Optionally narrow the search to a specific file.',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: {
        type: 'string' as const,
        minLength: 1,
        maxLength: 200,
        description: 'Function or method name (e.g. "chargeCard"). Matched case-sensitively.',
      },
      file: {
        type: 'string' as const,
        maxLength: 500,
        description: 'Optional repo-relative path to restrict the search to one file.',
      },
    },
    required: ['name'] as const,
    additionalProperties: false,
  },
};

export const FETCH_PRIOR_REVIEW_TOOL = {
  name: FETCH_PRIOR_REVIEW_TOOL_NAME,
  description:
    'Look up prior findings on this PR / file / rule. A finding with a non-null `dismissed_at` was previously rejected by a human reviewer — do not re-emit it. Returns an empty array when no prior reviews exist.',
  input_schema: {
    type: 'object' as const,
    properties: {
      pr_node_id: {
        type: 'string' as const,
        maxLength: 200,
        description: 'Optional GitHub PR node id to scope the lookup.',
      },
      file_path: {
        type: 'string' as const,
        maxLength: 500,
        description: 'Optional file path to filter prior findings.',
      },
      rule_id: {
        type: 'string' as const,
        maxLength: 200,
        description: 'Optional rule_id to filter prior findings.',
      },
    },
    additionalProperties: false,
  },
};

export const EMIT_FINDING_TOOL = {
  name: EMIT_FINDING_TOOL_NAME,
  description:
    'Terminal tool. Report which retrieved rules the PR diff violates and end the review. Call with an empty `findings` array when the diff is clean or when prior-review dismissals suppress the only candidate.',
  input_schema: {
    type: 'object' as const,
    properties: {
      findings: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            rule_id: { type: 'string' as const, minLength: 1, maxLength: 200 },
            title: { type: 'string' as const, minLength: 1, maxLength: 200 },
            message: { type: 'string' as const, minLength: 1, maxLength: 2000 },
            location_hint: { type: 'string' as const, maxLength: 500 },
            citation: { type: 'string' as const, maxLength: 1000 },
          },
          required: ['rule_id', 'title', 'message'] as const,
          additionalProperties: false,
        },
        maxItems: 10,
      },
    },
    required: ['findings'] as const,
    additionalProperties: false,
  },
};

export const REGISTERED_TOOLS = [
  FETCH_FILE_TOOL,
  FETCH_FUNCTION_TOOL,
  FETCH_PRIOR_REVIEW_TOOL,
  EMIT_FINDING_TOOL,
];

export function computePromptToolHash(): string {
  return createHash('sha256')
    .update(SYSTEM_PROMPT)
    .update(JSON.stringify(REGISTERED_TOOLS))
    .digest('hex');
}
