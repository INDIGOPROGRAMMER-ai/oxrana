import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('подставляет значения по умолчанию для необязательных переменных', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://x@127.0.0.1/db' });
    expect(config).toMatchObject({
      HOST: '127.0.0.1',
      PORT: 3000,
      LOG_LEVEL: 'info',
      NODE_ENV: 'development',
    });
  });

  it('без DATABASE_URL — ошибка с названием переменной, а не молчаливая подмена', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('неверный порт — ошибка', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', PORT: '70000' })).toThrow(/PORT/);
  });
});
