import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  Res,
  NotFoundException,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiProduces } from '@nestjs/swagger';
import { TemplateService } from './template.service';
import { CreateTemplateDto, UpdateTemplateDto, TemplateResponseDto } from './dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('templates')
@Controller('sessions/:sessionId/templates')
export class TemplateController {
  constructor(private readonly templateService: TemplateService) {}

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create a message template for the session (text or with a single media attachment)' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 201, description: 'Template created', type: TemplateResponseDto })
  async create(@Param('sessionId') sessionId: string, @Body() dto: CreateTemplateDto): Promise<TemplateResponseDto> {
    return this.templateService.toResponse(await this.templateService.create(sessionId, dto));
  }

  @Get()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List all templates for a session' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'List of templates', type: [TemplateResponseDto] })
  async findBySession(@Param('sessionId') sessionId: string): Promise<TemplateResponseDto[]> {
    const templates = await this.templateService.findBySession(sessionId);
    return templates.map(template => this.templateService.toResponse(template));
  }

  @Get(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Get a template by ID' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({ status: 200, description: 'Template details', type: TemplateResponseDto })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async findOne(@Param('sessionId') sessionId: string, @Param('id') id: string): Promise<TemplateResponseDto> {
    return this.templateService.toResponse(await this.templateService.findOne(sessionId, id));
  }

  @Get(':id/media')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: "Stream a template's media attachment (for dashboard preview)" })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiProduces('application/octet-stream')
  @ApiResponse({ status: 200, description: 'Raw media bytes' })
  @ApiResponse({ status: 404, description: 'Template not found or has no media' })
  async getMedia(@Param('sessionId') sessionId: string, @Param('id') id: string, @Res() res: Response): Promise<void> {
    const template = await this.templateService.findOne(sessionId, id);
    if (!template.mediaKey || !template.mediaType) {
      throw new NotFoundException('Template has no media attachment');
    }
    const media = await this.templateService.loadMedia(template);
    res.setHeader('Content-Type', media.mimetype);
    res.setHeader('Cache-Control', 'private, no-store');
    if (media.filename) {
      // Quote-escape to keep a stray '"' in the filename from breaking the header.
      res.setHeader('Content-Disposition', `inline; filename="${media.filename.replace(/"/g, '')}"`);
    }
    res.send(media.buffer);
  }

  @Put(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update a template (including attaching, replacing, or removing its media)' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({ status: 200, description: 'Template updated', type: TemplateResponseDto })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async update(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Body() dto: UpdateTemplateDto,
  ): Promise<TemplateResponseDto> {
    return this.templateService.toResponse(await this.templateService.update(sessionId, id, dto));
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a template' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({ status: 204, description: 'Template deleted' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async delete(@Param('sessionId') sessionId: string, @Param('id') id: string): Promise<void> {
    return this.templateService.delete(sessionId, id);
  }
}
