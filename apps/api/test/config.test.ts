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

  it('TRUST_PROXY и APP_VERSION: по умолчанию выключено, неверное значение — ошибка', () => {
    const base = { DATABASE_URL: 'postgres://x@127.0.0.1/db' };
    expect(loadConfig(base)).toMatchObject({ TRUST_PROXY: false });
    expect(loadConfig({ ...base, TRUST_PROXY: 'true', APP_VERSION: 'v1' })).toMatchObject({
      TRUST_PROXY: true,
      APP_VERSION: 'v1',
    });
    expect(() => loadConfig({ ...base, TRUST_PROXY: '1' })).toThrow(/TRUST_PROXY/);
  });

  it('без DATABASE_URL — ошибка с названием переменной, а не молчаливая подмена', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('неверный порт — ошибка', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', PORT: '70000' })).toThrow(/PORT/);
  });
});
