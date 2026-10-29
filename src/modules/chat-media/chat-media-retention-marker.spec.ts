import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../../common/storage/storage.service';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { updateMessageMetadata } from '../message/message-metadata';
import { ChatMediaArchiveService } from './chat-media-archive.service';

const config = (values: Record<string, unknown>): ConfigService =>
  ({ get: (key: string, fallback?: unknown) => (key in values ? values[key] : fallback) }) as unknown as ConfigService;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Retention removes an archived file. Under MESSAGE_INLINE_MEDIA=archive the row then has no copy of the media
 * left, and it must stop saying it has one. SQLite in memory; on PostgreSQL (DATABASE_TYPE=postgres) a schema of
 * its own, since the marker is found with SQL that differs by dialect.
 */
describe('archive-only media after retention removes the file', () => {
  const pg = process.env.DATABASE_TYPE === 'postgres';
  const server = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'openwa',
    password: process.env.DATABASE_PASSWORD || 'openwa',
    database: process.env.DATABASE_NAME || 'openwa',
  };
  let schema = '';
  const onServer = async (sql: string): Promise<void> => {
    const admin = await new DataSource(server).initialize();
    await admin.query(sql).finally(() => admin.destroy());
  };
  let dir: string;
  let ds: DataSource;
  let repository: Repository<Message>;
  let storage: StorageService;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-retention-marker-'));
    if (pg) {
      schema = `retention_marker_${randomUUID().replace(/-/g, '')}`;
      await onServer(`CREATE SCHEMA "${schema}"`);
    }
    const entities = [Message];
    ds = await new DataSource(
      pg
        ? { ...server, schema, extra: { options: `-c search_path=${schema},public` }, entities, synchronize: true }
        : { type: 'better-sqlite3', database: ':memory:', entities, synchronize: true },
    ).initialize();
    repository = ds.getRepository(Message);
    storage = new StorageService(config({ 'storage.type': 'local', 'storage.localPath': path.join(dir, 'media') }));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await ds.destroy();
    if (pg) await onServer(`DROP SCHEMA "${schema}" CASCADE`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const service = (inlineMode: 'inline' | 'archive'): ChatMediaArchiveService =>
    new ChatMediaArchiveService(
      repository,
      storage,
      config({ 'chatMedia.archiveEnabled': true, 'chatMedia.inlineMode': inlineMode, 'chatMedia.ttlDays': 1 }),
    );

  /** An inbound image row, archived by `archive` the way the projector does after persisting it. */
  async function archivedRow(archive: ChatMediaArchiveService): Promise<Message> {
    const row = await repository.save(
      repository.create({
        sessionId: 'sess-1',
        chatId: '628111@c.us',
        waMessageId: `WA-${randomUUID()}`,
        from: '628111@c.us',
        to: 'me@c.us',
        body: '',
        type: 'image',
        direction: MessageDirection.INCOMING,
        status: MessageStatus.SENT,
        timestamp: 1,
        metadata: { media: { mimetype: 'image/png', data: PNG.toString('base64') } },
      }),
    );
    expect(await archive.archive(row)).not.toBeNull();
    return repository.findOneByOrFail({ id: row.id });
  }

  const twoDaysLater = (): number => Date.now() + 2 * DAY_MS;

  it('no longer advertises an archived copy once the archived file is gone', async () => {
    const archive = service('archive');
    const row = await archivedRow(archive);
    expect(row.metadata.media).toMatchObject({ omitted: true, archived: true });
    await updateMessageMetadata(repository, { id: row.id }, metadata => ({ ...metadata, reactions: { a: 'like' } }));

    expect(await archive.purgeExpired(twoDaysLater())).toBe(1);

    const after = await repository.findOneByOrFail({ id: row.id });
    expect(after.mediaPath).toBeNull();
    expect(await archive.getMedia('sess-1', ['628111@c.us'], row.waMessageId)).toBeNull();
    // The list API hands this metadata to clients; `archived: true` tells them the bytes are behind the
    // media route (the dashboard fetches a preview for it), and they no longer are.
    expect(after.metadata).toEqual({
      media: { mimetype: 'image/png', omitted: true, sizeBytes: PNG.length },
      reactions: { a: 'like' },
    });
  });

  it('leaves the metadata of an inline-mode row untouched', async () => {
    const archive = service('inline');
    const row = await archivedRow(archive);
    const update = jest.spyOn(repository, 'update');

    expect(await archive.purgeExpired(twoDaysLater())).toBe(1);

    const after = await repository.findOneByOrFail({ id: row.id });
    expect(after.mediaPath).toBeNull();
    expect(after.metadata).toEqual(row.metadata);
    expect(update.mock.calls.filter(([, patch]) => 'metadata' in (patch as object))).toEqual([]);
  });

  it('keeps the marker and the columns while the file cannot be deleted', async () => {
    const archive = service('archive');
    const row = await archivedRow(archive);
    jest.spyOn(storage, 'deleteFile').mockRejectedValue(new Error('store unreachable'));

    expect(await archive.purgeExpired(twoDaysLater())).toBe(0);

    const after = await repository.findOneByOrFail({ id: row.id });
    expect(after.mediaPath).toBe(row.mediaPath);
    expect(after.metadata.media).toMatchObject({ archived: true });
  });

  it('keeps a reaction written while the marker is dropped', async () => {
    const archive = service('archive');
    const row = await archivedRow(archive);
    const update = repository.update.bind(repository);
    let raced = false;
    jest.spyOn(repository, 'update').mockImplementation(async (where, patch) => {
      if (!raced && 'metadata' in (patch as object)) {
        raced = true;
        await updateMessageMetadata(repository, { id: row.id }, metadata => ({
          ...metadata,
          reactions: { b: 'love' },
        }));
      }
      return update(where, patch);
    });

    expect(await archive.purgeExpired(twoDaysLater())).toBe(1);

    const after = await repository.findOneByOrFail({ id: row.id });
    expect(after.metadata).toEqual({
      media: { mimetype: 'image/png', omitted: true, sizeBytes: PNG.length },
      reactions: { b: 'love' },
    });
  });

  it('retries a row on the next run when its marker could not be dropped', async () => {
    const archive = service('archive');
    const row = await archivedRow(archive);
    const update = repository.update.bind(repository);
    const metadataWrites = jest
      .spyOn(repository, 'update')
      .mockImplementation((where, patch) =>
        'metadata' in (patch as object)
          ? Promise.resolve({ affected: 0, raw: [], generatedMaps: [] })
          : update(where, patch),
      );

    expect(await archive.purgeExpired(twoDaysLater())).toBe(0);
    expect((await repository.findOneByOrFail({ id: row.id })).mediaPath).toBe(row.mediaPath);

    metadataWrites.mockRestore();
    expect(await archive.purgeExpired(twoDaysLater())).toBe(1);

    const after = await repository.findOneByOrFail({ id: row.id });
    expect(after.mediaPath).toBeNull();
    expect(after.metadata.media).not.toHaveProperty('archived');
  });
});
