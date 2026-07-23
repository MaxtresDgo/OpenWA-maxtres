import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Session } from '../../session/entities/session.entity';

// One template name per session: makes resolve-by-name deterministic and rejects duplicates.
// Mirrored by the AddTemplateNameUnique migration for non-synchronize (Postgres / opted-out) DBs.
@Index('IDX_templates_session_name', ['sessionId', 'name'], { unique: true })
@Entity('templates')
export class Template {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // varchar (not uuid) to match the authoritative migration DDL and sessions.id; the data connection
  // runs synchronize:false, so a 'uuid' decorator here would only mislead schema diffs / a stray sync.
  @Column({ type: 'varchar' })
  sessionId: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId' })
  session: Session;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  // Nullable so a media-only template (an attachment with no caption text) is valid. Text templates
  // still require a body at the DTO layer; the DB just no longer forbids the empty-body media case.
  @Column({ type: 'text', nullable: true })
  body: string | null;

  @Column({ type: 'text', nullable: true })
  header: string | null;

  @Column({ type: 'text', nullable: true })
  footer: string | null;

  // ---- Optional single media attachment (issue: multimedia templates) ----
  // When set, the template renders as a media message (image/video/document/audio) whose caption is
  // the rendered header+body+footer, instead of a plain text message. The binary itself lives in the
  // StorageService backend (Local/S3); only this reference + metadata are persisted here.
  @Column({ type: 'varchar', length: 16, nullable: true })
  mediaType: 'image' | 'video' | 'document' | 'audio' | null;

  // Storage key under the media root (e.g. templates/<sessionId>/<id>/<uuid>.<ext>). Never exposed
  // raw in API responses — the binary is served through a dedicated stream endpoint.
  @Column({ type: 'text', nullable: true })
  mediaKey: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  mimetype: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  filename: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
