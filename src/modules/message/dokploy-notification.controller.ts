import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { DokployNotificationDto, DokployNotificationTargetDto } from './dto/dokploy-notification.dto';
import { MessageResponseDto } from './dto/send-message.dto';
import { MessageService } from './message.service';

const MESSAGE_TEXT_MAX_LENGTH = 4096;

@ApiTags('integration')
@Controller('integration/dokploy/:sessionId/:chatId')
export class DokployNotificationController {
  constructor(private readonly messages: MessageService) {}

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Forward a Dokploy Custom notification to a WhatsApp group' })
  @ApiParam({ name: 'sessionId', description: 'ID of the connected WhatsApp session', format: 'uuid' })
  @ApiParam({ name: 'chatId', description: 'Destination group ID, ending in @g.us' })
  @ApiBody({ type: DokployNotificationDto })
  @ApiResponse({ status: 201, description: 'Notification submitted to WhatsApp', type: MessageResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid notification or destination, or session not active' })
  @ApiResponse({ status: 409, description: 'WhatsApp session is not ready' })
  @ApiResponse({ status: 503, description: 'WhatsApp is unavailable or sending is temporarily limited' })
  notify(
    @Param() target: DokployNotificationTargetDto,
    @Body() notification: DokployNotificationDto,
  ): Promise<MessageResponseDto> {
    const text = [
      `🔔 Dokploy: ${notification.title}`,
      notification.message.slice(0, 500),
      notification.projectName && `Proyecto: ${notification.projectName}`,
      notification.applicationName && `Aplicación: ${notification.applicationName}`,
      // Keep the build link ahead of errors so long logs cannot truncate it away.
      notification.buildLink && `Logs: ${notification.buildLink}`,
      notification.errorMessage && `Error:\n${notification.errorMessage}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    return this.messages.sendText(target.sessionId, {
      chatId: target.chatId,
      text: text.length > MESSAGE_TEXT_MAX_LENGTH ? `${text.slice(0, MESSAGE_TEXT_MAX_LENGTH - 1)}…` : text,
    });
  }
}
