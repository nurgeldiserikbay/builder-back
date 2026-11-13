import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { ImagesService } from './images.service.js';
import { MAX_UPLOAD_BYTES } from './image-processing.js';

type UploadedImage = { buffer: Buffer; size: number };

@Controller('projects/:projectId/images')
@UseGuards(AuthGuard)
export class ImagesController {
  constructor(private readonly images: ImagesService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.images.list(request.user.id, projectId);
  }

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2, fieldSize: 1024 } }))
  upload(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @UploadedFile() file: UploadedImage | undefined, @Body() body: Record<string, unknown> | undefined) {
    return this.images.upload(request.user.id, projectId, file, body?.alt);
  }

  @Get(':imageId')
  async file(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('imageId') imageId: string, @Res() response: { set(headers: Record<string, string>): unknown; send(body: Buffer): unknown }) {
    const image = await this.images.file(request.user.id, projectId, imageId);
    response.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=3600', ETag: `"${image.etag}"`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
    response.send(image.data);
  }

  @Post(':imageId/alt')
  @HttpCode(200)
  setAlt(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('imageId') imageId: string, @Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'alt')) throw new BadRequestException('INVALID_REQUEST_BODY');
    return this.images.setAlt(request.user.id, projectId, imageId, (body as { alt?: unknown }).alt);
  }

  @Post(':imageId/crop')
  crop(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('imageId') imageId: string, @Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['x', 'y', 'width', 'height'].includes(key))) throw new BadRequestException('INVALID_REQUEST_BODY');
    return this.images.crop(request.user.id, projectId, imageId, body);
  }

  @Delete(':imageId')
  remove(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('imageId') imageId: string) {
    return this.images.remove(request.user.id, projectId, imageId);
  }
}
