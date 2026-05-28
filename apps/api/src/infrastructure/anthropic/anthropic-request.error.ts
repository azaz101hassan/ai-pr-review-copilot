// Typed error wrapping any Anthropic SDK failure. Mirrors
// `VoyageRequestError` shape so the call sites in `ReviewsService` can
// branch on `status` + `errorCode` without stringifying the message.
//
// SCRUB DISCIPLINE: we never include the response body, the request
// payload, the API key, the diff text, or any rule body in the message
// or in any field on this error. Anthropic's `APIError.message`
// default-stringifies the body; we intentionally construct our own
// message from `status` + `errorCode` only. The `cause` is kept for
// debugging but consumers should treat it as opaque and not stringify
// it into logs without auditing what it carries.
export class AnthropicRequestError extends Error {
  readonly name = 'AnthropicRequestError';
  readonly status: number;
  readonly errorCode?: string;
  // Server-provided textual explanation of why the request failed
  // (e.g. "Model not found" or "tools.0.input_schema: required field
  // missing"). This is the SERVER'S explanation, not echoed input —
  // safe to surface in logs. Distinct from `Error.message` which we
  // construct ourselves.
  readonly serverMessage?: string;
  override readonly cause?: unknown;

  constructor(
    message: string,
    opts: {
      status: number;
      errorCode?: string;
      serverMessage?: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.status = opts.status;
    this.errorCode = opts.errorCode;
    this.serverMessage = opts.serverMessage;
    this.cause = opts.cause;
  }
}
