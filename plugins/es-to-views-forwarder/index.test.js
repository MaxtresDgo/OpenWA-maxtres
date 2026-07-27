'use strict';
const assert = require('node:assert');
const Plugin = require('./index.js').default;

async function run() {
  const sent = [];
  let handler;
  const ctx = {
    config: { sourceGroupId: 'es@g.us', targetGroupId: 'views@g.us' },
    registerHook: (_event, fn) => { handler = fn; },
    messages: { sendText: async (sessionId, chatId, text) => { sent.push({ sessionId, chatId, text }); } },
  };
  await new Plugin().onLoad(ctx);

  // forwards a group message from the source group, sent via the same session it arrived on
  await handler({ sessionId: 'sess-1', data: { isGroup: true, chatId: 'es@g.us', fromMe: false, body: 'hola' } });
  assert.deepStrictEqual(sent, [{ sessionId: 'sess-1', chatId: 'views@g.us', text: 'hola' }]);

  // ignores messages from other chats
  sent.length = 0;
  await handler({ sessionId: 'sess-1', data: { isGroup: true, chatId: 'other@g.us', fromMe: false, body: 'x' } });
  assert.deepStrictEqual(sent, []);

  // ignores our own forwarded copy (loop guard)
  sent.length = 0;
  await handler({ sessionId: 'sess-1', data: { isGroup: true, chatId: 'es@g.us', fromMe: true, body: 'echo' } });
  assert.deepStrictEqual(sent, []);

  console.log('ok');
}

run();
