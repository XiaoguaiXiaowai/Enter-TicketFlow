import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class CreateKbArticleDto {
  @ApiProperty({ example: 'refund-policy', description: '项目内唯一的小写短标识' })
  @IsString()
  @Matches(SLUG_PATTERN, { message: 'slug 只能包含小写字母、数字与连字符，最长 64 字符' })
  slug!: string;

  @ApiProperty({ example: '退款政策' })
  @IsString()
  @Length(1, 200)
  title!: string;

  @ApiProperty({ example: '自签收之日起 7 天内可申请退款。' })
  @IsString()
  @Length(1, 20000)
  body!: string;
}

export class UpdateKbArticleDto {
  @ApiProperty({ example: '退款政策（2026 修订）' })
  @IsString()
  @Length(1, 200)
  title!: string;

  @ApiProperty({ example: '自签收之日起 15 天内可申请退款。' })
  @IsString()
  @Length(1, 20000)
  body!: string;
}

export class PublishKbArticleDto {
  @ApiProperty({ example: 1, description: '要发布的版本号，必须是当前最新版本' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  versionNo!: number;

  @ApiPropertyOptional({ example: '首次发布' })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  comment?: string;
}

export class ListKbArticlesQueryDto {
  @ApiPropertyOptional({ description: '检索关键词，空值时按更新时间列出已发布文章' })
  @IsOptional()
  @IsString()
  @Length(0, 100)
  q?: string;

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

export class RenderReplyTemplateDto {
  @ApiProperty({
    example: { customer_name: '张先生', order_no: 'SO-1024' },
    description: '键必须在模板声明的变量白名单内，值会被 HTML 转义',
  })
  @IsObject()
  variables!: Record<string, string>;
}
