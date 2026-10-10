import {
  ERROR_HTTP_STATUS,
  ERROR_MESSAGES,
  type ErrorBody,
  type ErrorCode,
} from '@oxrana/contracts';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { AppError } from './errors';

function send(reply: FastifyReply, request: FastifyRequest, body: Omit<ErrorBody, 'requestId'>) {
  const payload: ErrorBody = { ...body, requestId: request.id };
  return reply.status(ERROR_HTTP_STATUS[body.code]).send(payload);
}

function plain(code: ErrorCode, message?: string): Omit<ErrorBody, 'requestId'> {
  return { code, message: message ?? ERROR_MESSAGES[code], field: null, settingLink: null };
}

/** Единый формат ошибок `{code, message, field, settingLink, requestId}` (CLAUDE.md, правило 8). */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) =>
    send(reply, request, plain('not_found', `Адрес ${request.method} ${request.url} не найден.`)),
  );

  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    if (error instanceof AppError) {
      return send(reply, request, {
        code: error.code,
        message: error.message,
        field: error.field,
        settingLink: error.settingLink,
        ...(error.permission !== null ? { permission: error.permission } : {}),
      });
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const first = error.validation[0];
      const field =
        first?.instancePath.replace(/^\//, '').replaceAll('/', '.') ||
        error.validationContext ||
        null;
      const issue = first?.message ?? '';
      return send(reply, request, {
        code: 'validation_failed',
        message: field
          ? `Некорректное значение поля «${field}»${issue ? `: ${issue}` : ''}. Исправьте его и повторите.`
          : ERROR_MESSAGES.validation_failed,
        field,
        settingLink: null,
      });
    }

    // Ошибки самого Fastify: битый JSON, слишком большое тело и т. п.
    const status = (error as FastifyError).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return send(reply, request, plain('bad_request'));
    }

    request.log.error({ err: error }, 'Необработанная ошибка');
    return send(reply, request, plain('internal'));
  });
}
