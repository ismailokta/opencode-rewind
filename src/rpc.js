import { Rpc } from '@opencode/plugin/rpc';
const s = { type: 'string' }, b = { type: 'boolean' };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const method = (input, output) => ({ input: object(input), output: object(output), errors: {} });
const result = { success: b, message: s };
export const RewindRpc = Rpc.define({ id: 'opencode-rewind', methods: {
  // Read-only activity observation: the server hands out a request; a TUI replies before its deadline.
  next: method({}, { nonce: s, sessionID: s }),
  reply: method({ nonce: s, state: s }, { accepted: b }),
  checkpoint: method({ sessionID: s, messageID: s }, { status: s, reason: s }),
  deleteSnapshot: method({ sessionID: s, messageID: s }, result),
  clearSnapshots: method({ sessionID: s }, result),
  prepare: method({ sessionID: s, messageID: s }, { token: s, changes: { type: 'array', items: object({ name: s, action: s }) }, reason: s }),
  begin: method({ token: s }, { sessionID: s, messageID: s }),
  finish: method({ token: s }, result),
  beginUndo: method({ sessionID: s }, { sessionID: s, messageID: s, ...result }),
  finishUndo: method({ sessionID: s }, result),
  inspect: method({}, { message: s }),
  recovery: method({ sessionID: s }, { message: s }),
  previewRecovery: method({ sessionID: s }, { success: b, message: s, changes: { type: 'array', items: object({ name: s, action: s }) } }),
  recoverFiles: method({ sessionID: s }, result),
  discard: method({ sessionID: s }, result)
}, events: {} });
