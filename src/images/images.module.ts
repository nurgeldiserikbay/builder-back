import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JourneyModule } from '../journey/journey.module.js';
import { ImagesController } from './images.controller.js';
import { ImagesService } from './images.service.js';

@Module({ imports: [AuthModule, JourneyModule], controllers: [ImagesController], providers: [ImagesService] })
export class ImagesModule {}
