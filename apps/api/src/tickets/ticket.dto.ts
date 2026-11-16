import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

import {
  TICKET_PRIORITIES,
  TICKET_SOURCES,
  TICKET_STATUSES,
  type MessageVisibility,
  type TicketPriority,
  type TicketSource,
  type TicketStatus,
} from '@ticket/shared';

const PHONE_PATTERN = /^1[3-9]\d{9}$/;

export class CreateTicketDto {
  @ApiProperty({ example: '无法登录后台' })
  @IsString()
  @Length(1, 200)
  subject!: string;

  @ApiProperty({ example: '客户反馈输入正确密码仍提示凭证错误，已尝试重置。' })
  @IsString()
  @Length(1, 20000)
  description!: string;

  @ApiPropertyOptional({ enum: TICKET_PRIORITIES, default: 'NORMAL' })
  @IsOptional()
  @IsIn(TICKET_PRIORITIES as string[])
  priority?: TicketPriority;

  @ApiProperty({ example: '张先生' })
  @IsString()
  @Length(1, 100)
  customerName!: string;

  @ApiPropertyOptional({ example: '13800001234' })
  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, { message: 'customerPhone 必须是合法的中国大陆手机号' })
  customerPhone?: string;

  @ApiPropertyOptional({ description: '受理人 ID' })
  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @ApiPropertyOptional({ type: [String], example: ['登录', '高优'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Length(1, 40, { each: true })
  tags?: string[];

  @ApiPropertyOptional({ enum: TICKET_SOURCES, default: 'WEB' })
  @IsOptional()
  @IsIn(TICKET_SOURCES as string[])
  source?: TicketSource;
}

export class UpdateTicketDto {
  @ApiPropertyOptional({ enum: TICKET_STATUSES })
  @IsOptional()
  @IsIn(TICKET_STATUSES as string[])
  status?: TicketStatus;

  @ApiPropertyOptional({ enum: TICKET_PRIORITIES })
  @IsOptional()
  @IsIn(TICKET_PRIORITIES as string[])
  priority?: TicketPriority;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUUID()
  assigneeId?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Length(1, 40, { each: true })
  tags?: string[];

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @Length(1, 2000)
  internalNote?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 128.5 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  refundAmount?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, { message: 'customerPhone 必须是合法的中国大陆手机号' })
  customerPhone?: string;
}

export class AppendMessageDto {
  @ApiProperty({ example: '已收到，正在排查登录服务。' })
  @IsString()
  @Length(1, 10000)
  body!: string;

  @ApiProperty({ enum: ['PUBLIC', 'INTERNAL'], example: 'PUBLIC' })
  @IsIn(['PUBLIC', 'INTERNAL'])
  visibility!: MessageVisibility;

  @ApiPropertyOptional({ description: '回复模板 ID；提供时由服务端渲染正文并覆盖 body' })
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @ApiPropertyOptional({ description: '模板变量，值必须是字符串' })
  @IsOptional()
  @IsObject()
  templateVariables?: Record<string, unknown>;
}

export class ListTicketsQueryDto {
  @ApiPropertyOptional({ enum: TICKET_STATUSES })
  @IsOptional()
  @IsIn(TICKET_STATUSES as string[])
  status?: TicketStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @ApiPropertyOptional({ default: 20, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ description: '上一页返回的 nextCursor' })
  @IsOptional()
  @IsString()
  cursor?: string;
}
