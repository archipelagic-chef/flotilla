import { describe, expect, it } from 'vitest';
import { tabLabel } from '../../../../src/ui/sidebar/tabLabel';

describe('tabLabel', () => {
  it.each([
    ['ABC-123-add-login', 'ABC-123'],
    ['feature/PROJ-42-login-form', 'PROJ-42'],
    ['feature/PROJ-42', 'PROJ-42'],
    ['bugfix/abc-123-crash', 'ABC-123'],
    ['abc-7', 'ABC-7'],
    ['123-fix-login', '#123'],
    ['feature/42_typo', '#42'],
    ['main', 'main'],
    ['feature/login', 'login'],
    ['refactor/api-client', 'api-client'],
    ['feature/a-really-long-branch-name-here', 'a-really-long-bra…'],
    ['detached @ abc1234', 'detached @ abc1234'],
  ])('%s -> %s', (branch, expected) => expect(tabLabel(branch)).toBe(expected));

  it('does not take version-like or mid-word numbers for ids', () => {
    expect(tabLabel('release/v2-cleanup')).toBe('v2-cleanup');
    expect(tabLabel('feature/oauth2-login')).toBe('oauth2-login');
  });

  it('uses a custom pattern first, then falls back', () => {
    expect(tabLabel('team/T1234/login', 'T\\d+')).toBe('T1234');
    expect(tabLabel('story-88-x', 'story-(\\d+)')).toBe('88');
    expect(tabLabel('feature/login', 'T\\d+')).toBe('login');
    expect(tabLabel('ABC-1', '(')).toBe('ABC-1');
  });
});
