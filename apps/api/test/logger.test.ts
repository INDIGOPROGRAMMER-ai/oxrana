import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { loggerOptions } from '../src/logger';

function capture(): { lines: () => Record<string, unknown>[]; stream: Writable } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l)),
  };
}

describe('логи: редакция персональных данных', () => {
  it('телефон, e-mail, ФИО и пароль не попадают в лог, остальное остаётся', () => {
    const { stream, lines } = capture();
    const log = pino(loggerOptions('info'), stream);
    log.info(
      {
        phone: '+70000000000',
        visitor: { fullName: 'Иванов Иван', email: 'ivan@example.test', plate: 'А123ВС174' },
        req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1', host: 'example.test' } },
      },
      'проверка',
    );
    const [line] = lines();
    expect(JSON.stringify(line)).not.toMatch(/70000000000|Иванов|ivan@|Bearer abc|sid=1/);
    expect(line).toMatchObject({
      phone: '[скрыто]',
      visitor: { fullName: '[скрыто]', email: '[скрыто]', plate: 'А123ВС174' },
      req: { headers: { host: 'example.test' } },
    });
  });
});
