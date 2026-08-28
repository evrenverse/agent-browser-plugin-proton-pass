/** Envelope handling for the agent-browser.plugin.v1 stdio protocol. */

export const PROTOCOL = 'agent-browser.plugin.v1';

/**
 * Build a success envelope.
 * @param {string} payloadKey - Response field name, e.g. "manifest" or "credential".
 * @param {object} payload
 */
export function ok(payloadKey, payload) {
  return { protocol: PROTOCOL, success: true, [payloadKey]: payload };
}

/**
 * Build a failure envelope. The message is shown to the agent, so it names the
 * fix rather than the internal cause.
 * @param {string} message
 */
export function fail(message) {
  return { protocol: PROTOCOL, success: false, error: message };
}

/**
 * Parse and validate one request from stdin.
 * @param {string} rawInput
 * @returns {{type: string, capability?: string, request: object}}
 */
export function parseRequest(rawInput) {
  let parsed;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    throw new Error('Plugin input was not valid JSON.');
  }
  // `null` is valid JSON, so the optional chain is what keeps a non-object body
  // from answering with a raw TypeError instead of a sentence.
  if (parsed?.protocol !== PROTOCOL) {
    throw new Error(`Unsupported protocol "${parsed?.protocol}". This plugin speaks ${PROTOCOL}.`);
  }
  return { type: parsed.type, capability: parsed.capability, request: parsed.request ?? {} };
}
