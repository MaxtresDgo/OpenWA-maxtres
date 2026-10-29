import type { WAMessage } from '@whiskeysockets/baileys';
import { BaileysSessionStore } from './baileys-session-store';
import {
  mergeTwinStates,
  type ChatStateField,
  type ChatStateStore,
  type ChatStateValue,
} from './baileys-chat-state-store.service';
import type { LidMappingStore } from '../identity/lid-mapping-store.service';

/**
 * In-memory ChatStateStore. With `foldDelayMs` a fold lands after the caller returns, as the real store's
 * does on its write chain, and a forget queues behind it on the same chain.
 */
class FakeChatStateStore implements ChatStateStore {
  readonly rows = new Map<string, ChatStateValue>();
  private chain: Promise<void> = Promise.resolve();
  private clock = 1_000_000;
  constructor(private readonly foldDelayMs = 0) {}
  private key(s: string, c: string): string {
    return `${s}\u0000${c}`;
  }
  get(s: string, c: string): ChatStateValue | undefined {
    return this.rows.get(this.key(s, c));
  }
  chatIds(s: string): string[] {
    return [...this.rows.keys()].filter(k => k.startsWith(`${s}\u0000`)).map(k => k.slice(s.length + 1));
  }
  remember(s: string, c: string, patch: Partial<ChatStateValue>): Promise<void> {
    const existing = this.rows.get(this.key(s, c)) ?? {
      muteEndTime: null,
      archived: false,
      pinned: false,
      observed: [],
    };
    const observed = [...new Set([...(existing.observed ?? []), ...(Object.keys(patch) as ChatStateField[])])];
    this.rows.set(this.key(s, c), { ...existing, ...patch, observed, updatedAt: ++this.clock });
    return Promise.resolve();
  }
  reload(): Promise<void> {
    return Promise.resolve();
  }
  clearSession(): Promise<void> {
    return Promise.resolve();
  }
  fold(s: string, c: string, twins: string[], patch: Partial<ChatStateValue>): Promise<void> {
    const apply = (): Promise<void> => {
      const found = twins.filter(t => this.rows.has(this.key(s, t)));
      const merged = mergeTwinStates([c, ...found].flatMap(t => this.get(s, t) ?? []));
      for (const t of found) this.rows.delete(this.key(s, t));
      return this.remember(s, c, { ...(merged ?? {}), ...patch });
    };
    if (!this.foldDelayMs) return apply();
    this.chain = this.chain.then(() => new Promise<void>(resolve => setTimeout(resolve, this.foldDelayMs))).then(apply);
    return this.chain;
  }
  forget(s: string, chatIds: string[]): Promise<void> {
    this.chain = this.chain.then(() => {
      for (const c of chatIds) this.rows.delete(this.key(s, c));
    });
    return this.chain;
  }
  refreshSession(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * A chat deleted through the API (chats.delete, replayed by Baileys from its own patch) and then written to
 * again. The deletion is dated in milliseconds by the gateway's clock; a message carries whole seconds, so a
 * message from the deletion's own second is told apart by the order this session observed the two in.
 */
describe('Baileys chat deleted and then sent to within the same second', () => {
  const SID = 'sess-1';
  const PHONE = '628111@s.whatsapp.net';
  const DELETED_AT_MS = 1_800_000_000_400;
  const settle = (): Promise<unknown> => new Promise(resolve => setTimeout(resolve, 30));
  const message = (id: string, atMs: number, fromMe = true): WAMessage => ({
    key: { remoteJid: PHONE, fromMe, id },
    messageTimestamp: Math.floor(atMs / 1000),
    message: { conversation: id },
  });

  function deletedChat(foldDelayMs = 0) {
    const store = new BaileysSessionStore(undefined, SID, new FakeChatStateStore(foldDelayMs));
    store.upsertChats([{ id: PHONE, conversationTimestamp: 1_799_990_000 }]);
    const now = jest.spyOn(Date, 'now').mockReturnValue(DELETED_AT_MS);
    store.removeChats([PHONE]);
    return { store, now };
  }

  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['the mark has been written', 0],
    ['the mark is still on its way to the store', 5],
  ])('lists the chat a message sent half a second after the deletion re-created, when %s', async (_label, delay) => {
    const { store, now } = deletedChat(delay);
    if (!delay) {
      await settle();
      expect(store.listChats()).toEqual([]);
    }

    now.mockReturnValue(DELETED_AT_MS + 500);
    store.recordMessage(message('3EB0SENTAFTERTHEDELETE', DELETED_AT_MS + 500), 'text');
    await settle();

    expect(store.listChats().map(chat => chat.id)).toEqual(['628111@c.us']);
    expect(store.chatDeletedAt(PHONE)).toBeNull();
  });

  // A message from the next second clears the mark by timestamp alone, but one recorded before the mark
  // reached the store used to leave it behind once it landed.
  it('clears a mark that lands after a message from the next second re-created the chat', async () => {
    const { store, now } = deletedChat(5);

    now.mockReturnValue(DELETED_AT_MS + 1500);
    store.recordMessage(message('3EB0NEXTSECOND', DELETED_AT_MS + 1500), 'text');
    await settle();

    expect(store.listChats().map(chat => chat.id)).toEqual(['628111@c.us']);
    expect(store.chatDeletedAt(PHONE)).toBeNull();
  });

  it('keeps the chat deleted for a message of the same second that arrived before the deletion', async () => {
    const store = new BaileysSessionStore(undefined, SID, new FakeChatStateStore());
    store.upsertChats([{ id: PHONE, conversationTimestamp: 1_799_990_000 }]);
    // Its place in the order is taken on arrival, before the media download that can delay its record.
    const arrived = store.nextMessageOrder();
    jest.spyOn(Date, 'now').mockReturnValue(DELETED_AT_MS);
    store.removeChats([PHONE]);

    store.recordMessage(message('3EB0BEFORETHEDELETE', DELETED_AT_MS - 200, false), 'text', arrived);
    await settle();

    expect(store.listChats()).toEqual([]);
    expect(store.chatDeletedAt(PHONE)).toBe(DELETED_AT_MS);
  });

  it.each([
    ['a history message of the same second', DELETED_AT_MS - 100, 0],
    ['a message from an earlier second delivered late', DELETED_AT_MS - 5_000, undefined],
  ])('keeps the chat deleted for %s', async (_label, atMs, order) => {
    const { store } = deletedChat();

    store.recordMessage(message('3EB0OLDER', atMs, false), 'text', order);
    await settle();

    expect(store.listChats()).toEqual([]);
    expect(store.chatDeletedAt(PHONE)).toBe(DELETED_AT_MS);
  });
});

/**
 * Baileys merges the deletions of one buffered window, such as several chats deleted at once on the phone or
 * a catch-up after a reconnect, into one chats.delete event. A message re-creates only its own chat of it.
 */
describe('Baileys chats deleted together by one chats.delete event', () => {
  const SID = 'sess-1';
  const PHONE = '628111@s.whatsapp.net';
  const LID = '484848@lid';
  const OTHER = '628222@s.whatsapp.net';
  const DELETED_AT_MS = 1_800_000_000_400;
  const LATER_MS = DELETED_AT_MS + 10_000;
  const settle = (): Promise<unknown> => new Promise(resolve => setTimeout(resolve, 30));
  const message = (jid: string, id: string, atMs: number): WAMessage => ({
    key: { remoteJid: jid, fromMe: false, id },
    messageTimestamp: Math.floor(atMs / 1000),
    message: { conversation: id },
  });

  function deletedTogether(ids: string[], lidStore?: LidMappingStore) {
    const chatState = new FakeChatStateStore();
    const store = new BaileysSessionStore(lidStore, SID, chatState);
    store.upsertChats(ids.map(id => ({ id, conversationTimestamp: 1_799_990_000 })));
    jest.spyOn(Date, 'now').mockReturnValue(DELETED_AT_MS);
    store.removeChats(ids);
    return { store, chatState };
  }

  afterEach(() => jest.restoreAllMocks());

  it('keeps the other chat deleted when a message re-creates one, also after a restart', async () => {
    const { store, chatState } = deletedTogether([PHONE, OTHER]);
    await settle();

    store.recordMessage(message(PHONE, '3EB0REPLY', LATER_MS), 'text');
    // A state update from before the deletion, without a message, does not list the other chat again.
    store.upsertChats([{ id: OTHER, conversationTimestamp: 1_799_990_000 }]);
    await settle();

    expect(store.chatDeletedAt(PHONE)).toBeNull();
    expect(store.listChats().map(chat => chat.id)).toEqual(['628111@c.us']);
    expect(store.chatDeletedAt(OTHER)).toBe(DELETED_AT_MS);
    expect(chatState.get(SID, OTHER)?.deletedAt).toBe(DELETED_AT_MS);
    expect(new BaileysSessionStore(undefined, SID, chatState).chatDeletedAt(OTHER)).toBe(DELETED_AT_MS);
  });

  // The lid table can list the lid under the phone before the lid itself resolves, so the event names the
  // chat under two state keys whose spellings meet.
  it.each([
    ['the phone first', [PHONE, LID]],
    ['the lid first', [LID, PHONE]],
  ])('re-creates a chat named by both its lid and its phone under both, with %s', async (_label, ids) => {
    const lidStore: LidMappingStore = {
      getCached: () => undefined,
      resolveLid: () => null,
      lidsForPhone: phone => (phone === '628111' ? ['484848'] : []),
      remember: () => Promise.resolve(true),
    };
    const { store, chatState } = deletedTogether(ids, lidStore);
    await settle();
    expect(store.chatDeletedAt(LID)).toBe(DELETED_AT_MS);

    store.recordMessage(message(PHONE, '3EB0REPLY', LATER_MS), 'text');
    await settle();

    expect(store.chatDeletedAt(PHONE)).toBeNull();
    expect(store.chatDeletedAt(LID)).toBeNull();
    expect(chatState.rows.size).toBe(0);
  });

  it.each([
    ['its lid', LID],
    ['its phone', PHONE],
  ])(
    're-creates only the chat whose lid mapping arrived after the event, from a message under %s',
    async (_label, jid) => {
      const { store, chatState } = deletedTogether([LID, PHONE, OTHER]);
      await settle();
      store.addLidMappings([{ lid: LID, pn: PHONE }]);

      store.recordMessage(message(jid, '3EB0REPLY', LATER_MS), 'text');
      store.upsertChats([{ id: OTHER, conversationTimestamp: 1_799_990_000 }]);
      await settle();

      expect(store.chatDeletedAt(LID)).toBeNull();
      expect(store.chatDeletedAt('628111@c.us')).toBeNull();
      expect(store.listChats().map(chat => chat.id)).not.toContain('628222@c.us');
      expect(store.chatDeletedAt(OTHER)).toBe(DELETED_AT_MS);
      expect(chatState.get(SID, OTHER)?.deletedAt).toBe(DELETED_AT_MS);
    },
  );
});
