import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { loggerOptions, withoutQuery } from '../src/logger';

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
  it('телефон, e-mail, ФИО, номер и заголовки входа не попадают в лог, остальное остаётся', () => {
    const { stream, lines } = capture();
    const log = pino(loggerOptions('info'), stream);
    log.info(
      {
        phone: '+70000000000',
        visitor: {
          fullName: 'Иванов Иван',
          email: 'ivan@example.test',
          plate: 'А123ВС174',
          tenant: 'Арендатор',
        },
        req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1', host: 'example.test' } },
      },
      'проверка',
    );
    const [line] = lines();
    // Номер — ПДн (ARCHITECTURE §7.4, DATA_MODEL §6): редактируется с этапа 4. Заголовки запроса
    // в лог не попадают вовсе — сериализатор req оставляет метод и адрес без строки запроса.
    expect(JSON.stringify(line)).not.toMatch(/70000000000|Иванов|ivan@|А123ВС174|Bearer abc|sid=1/);
    expect(line).toMatchObject({
      phone: '[скрыто]',
      visitor: { fullName: '[скрыто]', email: '[скрыто]', plate: '[скрыто]', tenant: 'Арендатор' },
    });
  });
});

describe('логи: строка запроса не пишется', () => {
  it('поиск по номеру и фамилии не попадает в адрес запроса в логе', () => {
    expect(withoutQuery('/sites/1/passes?q=А123ВС174')).toBe('/sites/1/passes?…');
    expect(withoutQuery('/healthz')).toBe('/healthz');
  });

  it('номер и ФИО пешехода в теле редактируются', () => {
    const { stream, lines } = capture();
    const log = pino(loggerOptions('info'), stream);
    log.info({ body: { plateQuery: 'А123ВС174', personName: 'Петров' } }, 'тело');
    expect(JSON.stringify(lines()[0])).not.toMatch(/А123ВС174|Петров/);
  });
});
