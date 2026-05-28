import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import type { Schema } from 'hast-util-sanitize';

// Day-5 markdown sanitizer for finding text Claude emits.
//
// SCHEMA (custom, derived from rehype-sanitize's defaultSchema):
//   - tagNames: a narrow inline + list whitelist — strong/b/em/i,
//     code/pre (inline + block code), p, br, ul/ol/li. No anchors,
//     images, headings, tables, blockquotes, script/style/iframe.
//     The unified pipeline strips disallowed tags but preserves
//     their text content — so `[click here](http://evil)` becomes
//     `click here` (display text preserved, URL gone).
//   - attributes: only `code: ['className']` to keep the
//     `language-foo` hint for syntax highlighting.
//   - HTML comments: rehype-sanitize strips ALL comments by default;
//     the format-review-body helper injects our self-identifying
//     `<!-- ai-pr-review-copilot:v1:review-id=... -->` marker AFTER
//     the sanitizer runs so the marker survives without us having to
//     whitelist arbitrary comments through the Schema.
//
// What this function DOES:
//   - HTML escape: `<script>...</script>` → empty string in output
//     (rehype-sanitize strips tags AND drops script content per
//     defaults; same for style/iframe).
//   - Link stripping: `[text](url)` → `text` (no anchor in output).
//   - Image stripping: `![alt](url)` → empty string (no display
//     text survives; alt is dropped).
//   - Heading prevention: `# Title` parses to <h1> which the schema
//     rejects → text "Title" is preserved without the heading.
//
// What this function does NOT do:
//   - Per-line leading-character escaping outside code blocks. We
//     considered backslash-escaping `#`/`>`/`-`/`*` at line starts
//     but the unified roundtrip (markdown → HTML → text-only) already
//     strips the heading/list/blockquote structure. Tests assert
//     this.
//
// SECURITY CONTRACT enforced by the spec corpus:
//   - No raw <script> survives
//   - No external URLs reach the output
//   - No nested HTML attributes that could exfiltrate

const safeSchema: Schema = {
  ...defaultSchema,
  tagNames: [
    'strong',
    'b',
    'em',
    'i',
    'code',
    'pre',
    'p',
    'br',
    'ul',
    'ol',
    'li',
  ],
  // F16 closure: the previous `code: ['className']` accepted ANY
  // className value despite the source comment claiming a `language-*`
  // whitelist. Tuple form `[name, ...allowed]` constrains to values
  // that pattern-match the regex — any other class name (including
  // `<code class="x" onmouseover=...>` attempts where the schema
  // author misread the rehype-sanitize API) is dropped.
  attributes: {
    code: [['className', /^language-[\w.-]+$/]],
  },
  clobber: [],
  clobberPrefix: 'user-content-',
};

// Singleton processor — unified pipelines are expensive to build per
// call. Reuse across every finding in a review.
const processor = unified()
  .use(remarkParse)
  .use(remarkRehype, { allowDangerousHtml: false })
  // F22 closure: Schema is properly imported from
  // `hast-util-sanitize`, so the value passes straight through
  // without `as unknown as` boundary cast.
  .use(rehypeSanitize, safeSchema)
  .use(rehypeStringify);

/**
 * Sanitize a single finding's text (title / message / etc.) to a
 * GitHub-Markdown-safe subset. Pure function — no I/O, no logging.
 * Returns sanitized HTML; markdown structure is preserved when the
 * tags are in `safeSchema.tagNames`, stripped otherwise.
 *
 * F15 closure: rehype-stringify wraps simple text in `<p>...</p>`,
 * which breaks `**[error]** ${title}` inline embedding on GitHub
 * (the `<p>` introduces a paragraph break). Strip the wrapping
 * paragraph when it's the only top-level block element so the
 * formatter can use the sanitized text inline. Multi-paragraph
 * content keeps its structure.
 */
export function sanitizeFindingMarkdown(input: string): string {
  if (!input) return '';
  const file = processor.processSync(input);
  return stripWrappingParagraph(String(file).trim());
}

function stripWrappingParagraph(html: string): string {
  // Single leading <p> + trailing </p> with no other top-level <p>.
  // We don't try to be too clever — the typical input is a one-line
  // title or message; multi-paragraph content (with two or more
  // `<p>` blocks) flows through unchanged.
  const firstClose = html.indexOf('</p>');
  if (
    html.startsWith('<p>') &&
    firstClose === html.length - '</p>'.length &&
    html.indexOf('<p>', 3) === -1
  ) {
    return html.slice('<p>'.length, html.length - '</p>'.length);
  }
  return html;
}
