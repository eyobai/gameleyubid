import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { AppException, ErrorCode } from './errors';

const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: ErrorCode.VALIDATION_FAILED,
  401: ErrorCode.UNAUTHORIZED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  429: ErrorCode.RATE_LIMITED,
};

/** Every error leaves in one shape: { statusCode, error, message, details, path, timestamp }. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let error: string = ErrorCode.INTERNAL_ERROR;
    let message = 'Something went wrong. Try again.';
    let details: Record<string, unknown> | undefined;

    if (exception instanceof AppException) {
      status = exception.getStatus();
      error = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof ThrottlerException) {
      status = HttpStatus.TOO_MANY_REQUESTS;
      error = ErrorCode.RATE_LIMITED;
      message = 'Too many requests. Wait a moment and try again.';
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      error = CODE_BY_STATUS[status] ?? ErrorCode.INTERNAL_ERROR;
      const body = exception.getResponse() as { message?: unknown };
      if (Array.isArray(body?.message)) {
        message = 'Some fields are invalid';
        details = { fields: body.message };
      } else {
        message = typeof body?.message === 'string' ? body.message : exception.message;
      }
    } else if (
      exception instanceof Prisma.PrismaClientKnownRequestError &&
      (exception.code === 'P2024' || exception.code === 'P2028')
    ) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      error = ErrorCode.SERVICE_BUSY;
      message = 'The server is busy. Try again in a moment.';
      res.setHeader('Retry-After', '2');
    } else {
      this.logger.error(`${req.method} ${req.url}: ${exception instanceof Error ? exception.stack : String(exception)}`);
    }

    res.status(status).json({ statusCode: status, error, message, details: details ?? {}, path: req.url, timestamp: new Date().toISOString() });
  }
}
