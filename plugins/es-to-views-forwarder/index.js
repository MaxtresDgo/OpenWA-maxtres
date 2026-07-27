'use strict';

module.exports.default = class EsToViewsForwarderPlugin {
  async onLoad(ctx) {
    ctx.registerHook('message:received', async hookCtx => {
      const cfg = ctx.config;
      const message = hookCtx.data;

      if (!cfg.sourceGroupId || !cfg.targetGroupId || !hookCtx.sessionId) return { continue: true };
      // fromMe guard: without it, a reply landing back in the source group would re-forward forever.
      if (message.isGroup && message.chatId === cfg.sourceGroupId && !message.fromMe) {
        await ctx.messages.sendText(hookCtx.sessionId, cfg.targetGroupId, message.body ?? '');
      }
      return { continue: true };
    });
  }

  async healthCheck() {
    return { healthy: true };
  }
};
