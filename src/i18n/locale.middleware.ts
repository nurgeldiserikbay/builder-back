import { CallHandler, ExecutionContext, Injectable, NestInterceptor, NestMiddleware } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';

type Request = IncomingMessage;
type NextFunction = () => void;
import { map, type Observable } from 'rxjs';
import { localeFromHeader, localizeDeep, runWithLocale } from './i18n.js';

/** Remembers the request language for tr() anywhere down the call. */
@Injectable()
export class LocaleMiddleware implements NestMiddleware {
  use(request: Request, _response: unknown, next: NextFunction) {
    runWithLocale(localeFromHeader(request.headers['accept-language']), next);
  }
}

/** Translates platform texts in JSON responses for English requests. */
@Injectable()
export class LocalizeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const locale = localeFromHeader(request?.headers?.['accept-language']);
    return next.handle().pipe(map((body) => localizeDeep(body, locale)));
  }
}
