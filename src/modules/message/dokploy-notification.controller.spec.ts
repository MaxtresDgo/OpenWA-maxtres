import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Repository } from 'typeorm';
import { applyGlobalValidation } from '../../config/app-validation';
import { AuditService } from '../audit/audit.service';
import { hashApiKey } from '../auth/api-key-hash';
import { ApiKeyUsageTracker } from '../auth/api-key-usage-tracker.service';
import { AuthService } from '../auth/auth.service';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { DokployNotificationController } from './dokploy-notification.controller';
import { MessageService } from './message.service';

describe('Dokploy notifications over HTTP', () => {
  let app: INestApplication<App>;
  const sessionId = '8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a';
  const chatId = '120363021234567890@g.us';
  const url = `/api/integration/dokploy/${sessionId}/${chatId}`;
  const sendText = jest
    .fn<Promise<{ messageId: string; timestamp: number }>, [string, { chatId: string; text: string }]>()
    .mockResolvedValue({ messageId: 'sent-id', timestamp: 123 });
  const payload = {
    title: 'Build Error',
    message: 'Build failed with errors',
    projectName: 'Maxtres',
    applicationName: 'Backend',
    applicationType: 'application',
    errorMessage: 'npm run build exited with code 1',
    buildLink: 'https://dokploy.maxtres.org/dashboard/build/123',
    timestamp: '2026-10-29T19:00:00.000Z',
    date: '10/29/2026, 1:00:00 PM',
    status: 'error',
    type: 'build',
  };

  beforeAll(async () => {
    const keys = ['operator', 'viewer', 'unrestricted'].map(token => ({
      id: token,
      keyHash: hashApiKey(token),
      role: token === 'viewer' ? ApiKeyRole.VIEWER : ApiKeyRole.OPERATOR,
      isActive: true,
      allowedSessions: token === 'unrestricted' ? null : [sessionId],
      lastUsedAt: new Date(),
      usageCount: 0,
    }));
    const auth = new AuthService(
      {
        findOne: ({ where }: { where: { keyHash: string } }) => keys.find(key => key.keyHash === where.keyHash),
      } as unknown as Repository<ApiKey>,
      { record: jest.fn() } as unknown as ApiKeyUsageTracker,
      {} as ModuleRef,
    );
    const mod = await Test.createTestingModule({
      controllers: [DokployNotificationController],
      providers: [{ provide: MessageService, useValue: { sendText } }],
    }).compile();
    app = mod.createNestApplication({ logger: false });
    applyGlobalValidation(app);
    app.useGlobalGuards(
      new ApiKeyGuard(auth, new Reflector(), new ConfigService(), {
        logWarn: jest.fn().mockResolvedValue(null),
      } as unknown as AuditService),
    );
    await app.init();
  });

  afterAll(async () => app?.close());
  beforeEach(() => sendText.mockClear());

  it('accepts the unchanged Dokploy build-error payload and sends the details to the URL group', async () => {
    const response = await request(app.getHttpServer()).post(url).set('X-API-Key', 'operator').send(payload);
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ messageId: 'sent-id', timestamp: 123 });
    const [session, message] = sendText.mock.calls[0];
    expect(session).toBe(sessionId);
    expect(message.chatId).toBe(chatId);
    for (const value of ['Build Error', 'Maxtres', 'Backend', payload.errorMessage, payload.buildLink]) {
      expect(message.text).toContain(value);
    }
  });

  it('accepts the minimal Test notification with Bearer authentication', async () => {
    await request(app.getHttpServer())
      .post(url)
      .set('Authorization', 'Bearer operator')
      .send({ title: 'Test Notification', message: 'Hi, From Dokploy 👋', timestamp: payload.timestamp })
      .expect(201);
    expect(sendText.mock.calls[0][1].text).toContain('Hi, From Dokploy 👋');
    expect(sendText.mock.calls[0][1].text).not.toContain('undefined');
  });

  it('bounds long errors to 4096 characters while retaining the build link', async () => {
    await request(app.getHttpServer())
      .post(url)
      .set('X-API-Key', 'operator')
      .send({ ...payload, errorMessage: 'x'.repeat(20000) })
      .expect(201);
    const text = sendText.mock.calls[0][1].text;
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain(payload.buildLink);
    expect(text).toMatch(/…$/);
  });

  it.each([
    ['missing key', url, '', 401],
    ['invalid key', url, 'invalid', 401],
    ['viewer key', url, 'viewer', 403],
    ['another session', url.replace(sessionId, '11111111-1111-4111-8111-111111111111'), 'operator', 401],
  ])('refuses %s before sending', async (_label, path, key, status) => {
    await request(app.getHttpServer()).post(path).set('X-API-Key', key).send(payload).expect(status);
    expect(sendText).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { ...payload, title: false },
    { ...payload, title: 1 },
    { ...payload, message: '' },
    { ...payload, errorMessage: { secret: 'value' } },
    { ...payload, buildLink: 'javascript:alert(1)' },
    { ...payload, chatId },
    { ...payload, unexpected: true },
  ])('refuses malformed or additional input fields: %j', async body => {
    await request(app.getHttpServer()).post(url).set('X-API-Key', 'operator').send(body).expect(400);
    expect(sendText).not.toHaveBeenCalled();
  });

  it.each(['628111@c.us', 'invalid@g.us', '120363021234567890'])(
    'refuses a destination that is not a group ID: %s',
    async destination => {
      await request(app.getHttpServer())
        .post(url.replace(chatId, destination))
        .set('X-API-Key', 'unrestricted')
        .send(payload)
        .expect(400);
      expect(sendText).not.toHaveBeenCalled();
    },
  );

  it('returns a send failure to Dokploy rather than reporting delivery', async () => {
    sendText.mockRejectedValueOnce(new ServiceUnavailableException('Session unavailable'));
    await request(app.getHttpServer()).post(url).set('X-API-Key', 'operator').send(payload).expect(503);
  });
});
