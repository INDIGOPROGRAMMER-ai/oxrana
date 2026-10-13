import { describe, expect, it } from 'vitest';
import { checkBootstrapField } from '../src/cli/bootstrap-core';

describe('чистый старт: проверка полей при вводе', () => {
  it('пояс проверяется по Intl: «yes» и неполные адреса отклоняются с примером', () => {
    expect(checkBootstrapField('timezone', 'Asia/Yekaterinburg')).toBeNull();
    expect(checkBootstrapField('timezone', 'Europe/Moscow')).toBeNull();
    for (const bad of ['yes', 'Челябинск', 'asia/yekaterinburg', '', 'UTC+5']) {
      const problem = checkBootstrapField('timezone', bad);
      expect(problem, bad).toContain('Asia/Yekaterinburg');
    }
  });

  it('slug: латиница, цифры, дефис, 3–50 символов', () => {
    expect(checkBootstrapField('slug', 'integraciya')).toBeNull();
    expect(checkBootstrapField('slug', 'a-b')).toBeNull();
    for (const bad of ['ab', 'Integraciya', 'с пробелом', '-abc', 'abc-', 'интеграция']) {
      expect(checkBootstrapField('slug', bad), bad).toContain('латиница');
    }
  });

  it('e-mail и имена', () => {
    expect(checkBootstrapField('owner-email', 'o@example.ru')).toBeNull();
    expect(checkBootstrapField('owner-email', 'yes')).toContain('name@example.ru');
    expect(checkBootstrapField('owner-name', 'Иванов Иван')).toBeNull();
    expect(checkBootstrapField('owner-name', 'И')).not.toBeNull();
    expect(checkBootstrapField('org', ' ')).not.toBeNull();
  });
});
