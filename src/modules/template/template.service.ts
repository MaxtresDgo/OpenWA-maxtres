import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { Template } from './entities/template.entity';
import { CreateTemplateDto, UpdateTemplateDto, TemplateResponseDto, TemplateMediaType } from './dto';
import { createLogger } from '../../common/services/logger.service';
import { isUniqueConstraintError } from '../../common/utils/unique-constraint.util';
import { StorageService } from '../../common/storage/storage.service';
import { assertBase64WithinMediaCap, stripBase64DataUri } from '../message/media-cap.util';

/** Loaded media bytes plus the metadata the send path needs to build a MediaInput. */
export interface LoadedTemplateMedia {
  buffer: Buffer;
  mediaType: TemplateMediaType;
  mimetype: string;
  filename?: string;
}

// Minimal MIME→extension fallback for naming the stored object when the caller gives no filename.
// Purely cosmetic (the key just needs to be unique + safe); the mimetype column is the source of truth.
const MIME_EXTENSION: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'application/pdf': '.pdf',
};

@Injectable()
export class TemplateService {
  private readonly logger = createLogger('TemplateService');

  constructor(
    @InjectRepository(Template, 'data')
    private readonly templateRepository: Repository<Template>,
    private readonly storageService: StorageService,
  ) {}

  async create(sessionId: string, dto: CreateTemplateDto): Promise<Template> {
    // A template must carry a message: either text (body) or a media attachment. Enforced here, where
    // both fields are known, rather than via stacked @ValidateIf on the DTO (see template.dto.ts).
    if (!dto.mediaType && (dto.body == null || dto.body.trim().length === 0)) {
      throw new BadRequestException('A text template requires a non-empty body');
    }

    // Persist the row first so the generated id can namespace the storage key, then attach media.
    const template = this.templateRepository.create({
      sessionId,
      name: dto.name,
      body: dto.body ?? null,
      header: dto.header ?? null,
      footer: dto.footer ?? null,
    });

    let saved: Template;
    try {
      saved = await this.templateRepository.save(template);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new ConflictException(`A template named '${dto.name}' already exists for this session`);
      }
      throw err;
    }

    if (dto.mediaType) {
      // storeMedia validates the base64 cap before writing. If the upload fails, roll the row back so
      // we never leave a template that claims media it doesn't have.
      try {
        const mediaKey = await this.storeMedia(sessionId, saved.id, {
          mediaType: dto.mediaType,
          mediaBase64: dto.mediaBase64!,
          mimetype: dto.mimetype,
          filename: dto.filename,
        });
        saved.mediaType = dto.mediaType;
        saved.mediaKey = mediaKey;
        saved.mimetype = dto.mimetype ?? null;
        saved.filename = dto.filename ?? null;
        saved = await this.templateRepository.save(saved);
      } catch (err) {
        await this.templateRepository.remove(saved).catch(() => undefined);
        throw err;
      }
    }

    this.logger.log('Template created', {
      sessionId,
      templateId: saved.id,
      name: saved.name,
      hasMedia: !!saved.mediaKey,
    });
    return saved;
  }

  async findBySession(sessionId: string): Promise<Template[]> {
    return this.templateRepository.find({
      where: { sessionId },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(sessionId: string, id: string): Promise<Template> {
    const template = await this.templateRepository.findOne({ where: { id, sessionId } });
    if (!template) {
      throw new NotFoundException(`Template with id '${id}' not found`);
    }
    return template;
  }

  /**
   * Resolve a template for a session by id or by name. Throws NotFoundException
   * when neither identifier matches. Used by the send-template message flow.
   */
  async resolve(sessionId: string, identifier: { templateId?: string; templateName?: string }): Promise<Template> {
    const { templateId, templateName } = identifier;

    if (templateId) {
      return this.findOne(sessionId, templateId);
    }

    if (templateName) {
      // Order by createdAt ASC so resolution is deterministic if more than one row shares a name
      // (possible only on a DB predating the unique index); the migration keeps the earliest too.
      const template = await this.templateRepository.findOne({
        where: { name: templateName, sessionId },
        order: { createdAt: 'ASC' },
      });
      if (!template) {
        throw new NotFoundException(`Template with name '${templateName}' not found`);
      }
      return template;
    }

    throw new NotFoundException('Either templateId or templateName must be provided');
  }

  async update(sessionId: string, id: string, dto: UpdateTemplateDto): Promise<Template> {
    const template = await this.findOne(sessionId, id);

    if (dto.name !== undefined) template.name = dto.name;
    if (dto.body !== undefined) template.body = dto.body;
    if (dto.header !== undefined) template.header = dto.header;
    if (dto.footer !== undefined) template.footer = dto.footer;

    // Media transitions. Only one of replace/remove applies per request; replacing wins if both a new
    // mediaType and removeMedia arrive (an explicit new attachment is a stronger intent than a clear).
    const previousKey = template.mediaKey;
    if (dto.mediaType) {
      const mediaKey = await this.storeMedia(sessionId, id, {
        mediaType: dto.mediaType,
        mediaBase64: dto.mediaBase64!,
        mimetype: dto.mimetype,
        filename: dto.filename,
      });
      template.mediaType = dto.mediaType;
      template.mediaKey = mediaKey;
      template.mimetype = dto.mimetype ?? null;
      template.filename = dto.filename ?? null;
    } else if (dto.removeMedia) {
      template.mediaType = null;
      template.mediaKey = null;
      template.mimetype = null;
      template.filename = null;
    }

    // Guard the "no message left" state a media-clearing update could create.
    if (!template.mediaKey && (template.body == null || template.body.trim().length === 0)) {
      throw new BadRequestException('A text template requires a non-empty body');
    }

    let result: Template;
    try {
      result = await this.templateRepository.save(template);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new ConflictException(`A template named '${template.name}' already exists for this session`);
      }
      throw err;
    }

    // Delete the superseded/removed object only AFTER the row is safely persisted, so a save failure
    // never orphans the row from its still-referenced media. Best-effort — a storage hiccup here just
    // leaves a stray object, it must not fail the update.
    if (previousKey && previousKey !== template.mediaKey) {
      await this.storageService.deleteFile(previousKey).catch(err => {
        this.logger.warn('Failed to delete superseded template media', { mediaKey: previousKey, error: String(err) });
      });
    }

    return result;
  }

  async delete(sessionId: string, id: string): Promise<void> {
    const template = await this.findOne(sessionId, id);
    const mediaKey = template.mediaKey;
    await this.templateRepository.remove(template);

    if (mediaKey) {
      await this.storageService.deleteFile(mediaKey).catch(err => {
        this.logger.warn('Failed to delete template media on template delete', { mediaKey, error: String(err) });
      });
    }
    this.logger.log('Template deleted', { sessionId, templateId: id });
  }

  /**
   * Read a template's attached media from the storage backend, ready for the send path to wrap in a
   * MediaInput. Throws if the template has no media or the object is missing/unreadable.
   */
  async loadMedia(template: Template): Promise<LoadedTemplateMedia> {
    if (!template.mediaType || !template.mediaKey) {
      throw new BadRequestException('Template has no media attachment');
    }
    const buffer = await this.storageService.getFile(template.mediaKey);
    return {
      buffer,
      mediaType: template.mediaType,
      mimetype: template.mimetype ?? 'application/octet-stream',
      filename: template.filename ?? undefined,
    };
  }

  /** Map a persisted template to its API response shape — hides mediaKey, exposes a hasMedia flag. */
  toResponse(template: Template): TemplateResponseDto {
    return {
      id: template.id,
      sessionId: template.sessionId,
      name: template.name,
      body: template.body,
      header: template.header,
      footer: template.footer,
      hasMedia: !!template.mediaKey,
      mediaType: template.mediaType,
      mimetype: template.mimetype,
      filename: template.filename,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    };
  }

  /**
   * Decode, size-check, and persist a template's media into the storage backend under a
   * per-template key. Returns the storage key to record on the row.
   */
  private async storeMedia(
    sessionId: string,
    templateId: string,
    media: { mediaType: TemplateMediaType; mediaBase64: string; mimetype?: string; filename?: string },
  ): Promise<string> {
    const base64 = stripBase64DataUri(media.mediaBase64);
    if (!base64) {
      throw new BadRequestException('mediaBase64 is required and must be non-empty when mediaType is set');
    }
    // Same decoded-size cap as inbound/URL/base64 message media, enforced before allocating the buffer.
    assertBase64WithinMediaCap(base64);

    const buffer = Buffer.from(base64, 'base64');
    const ext = this.extensionFor(media.mediaType, media.filename, media.mimetype);
    const key = `templates/${sessionId}/${templateId}/${randomUUID()}${ext}`;
    await this.storageService.putFile(key, buffer);
    return key;
  }

  private extensionFor(mediaType: TemplateMediaType, filename?: string, mimetype?: string): string {
    const fromName = filename ? extname(filename) : '';
    if (fromName) return fromName.toLowerCase();
    if (mimetype && MIME_EXTENSION[mimetype]) return MIME_EXTENSION[mimetype];
    // Coarse fallback by media class so a document without a known mimetype at least gets a sane suffix.
    return mediaType === 'document' ? '.bin' : '';
  }
}
