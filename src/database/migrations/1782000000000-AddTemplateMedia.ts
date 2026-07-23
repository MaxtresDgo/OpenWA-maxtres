import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds an optional single media attachment to `templates` (multimedia templates). A template with a
 * `mediaType` renders as an image/video/document/audio message whose caption is the rendered
 * header+body+footer; the binary itself lives in the StorageService backend, so only a reference
 * (`mediaKey`) plus metadata are stored here. All columns are nullable so existing text-only
 * templates are untouched.
 *
 * Hand-authored (like AddTemplates) because `synchronize` is disabled for the `data` connection on
 * PostgreSQL and may be disabled on SQLite. `hasColumn` guards keep it idempotent on a
 * synchronize-bootstrapped DB where the entity columns already exist.
 */
export class AddTemplateMedia1782000000000 implements MigrationInterface {
  name = 'AddTemplateMedia1782000000000';

  private readonly columns: Array<{ name: string; type: string }> = [
    { name: 'mediaType', type: 'varchar(16)' },
    { name: 'mediaKey', type: 'text' },
    { name: 'mimetype', type: 'varchar(255)' },
    { name: 'filename', type: 'varchar(255)' },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasTable = await queryRunner.hasTable('templates');
    if (!hasTable) return;

    for (const column of this.columns) {
      const exists = await queryRunner.hasColumn('templates', column.name);
      if (!exists) {
        await queryRunner.query(`ALTER TABLE "templates" ADD COLUMN "${column.name}" ${column.type}`);
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const hasTable = await queryRunner.hasTable('templates');
    if (!hasTable) return;

    // SQLite gained DROP COLUMN in 3.35 (bundled with better-sqlite3); Postgres supports IF EXISTS.
    // Reverse order is cosmetic here since the columns are independent.
    for (const column of [...this.columns].reverse()) {
      const exists = await queryRunner.hasColumn('templates', column.name);
      if (exists) {
        await queryRunner.query(`ALTER TABLE "templates" DROP COLUMN "${column.name}"`);
      }
    }
  }
}
