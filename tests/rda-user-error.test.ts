import { describe, expect, it } from 'vitest';
import {
  extractRdaUsernameFromError,
  formatRdaUserNotFoundMessage,
  translateRdaJobError
} from '../src/rda-user-error';

describe('rda-user-error', () => {
  it('formats user-not-found message', () => {
    expect(formatRdaUserNotFoundMessage('player_1')).toBe('No se ha encontrado el usuario player_1');
  });

  it('extracts username from actionable-row errors', () => {
    expect(extractRdaUsernameFromError('No actionable rows found while searching for user "player_1"')).toBe(
      'player_1'
    );
  });

  it('translates missing-user balance errors to a clean message', () => {
    expect(
      translateRdaJobError('Step failed: 04-find-user-row (No actionable rows found while searching for user "player_1")', {
        usuario: 'player_1',
        operacion: 'consultar_saldo'
      })
    ).toBe('No se ha encontrado el usuario player_1');
  });

  it('translates ambiguous-user errors to a clean message', () => {
    expect(
      translateRdaJobError('Multiple exact matches found for user "player_1" (2)', {
        usuario: 'player_1'
      })
    ).toBe('Se encontraron multiples coincidencias para el usuario player_1');
  });

  it('translates ambiguous compact-user errors to a clean message', () => {
    expect(
      translateRdaJobError('Multiple compact matches found for user "0Robertino254" (2)', {
        usuario: '0Robertino254'
      })
    ).toBe('Se encontraron multiples coincidencias para el usuario 0Robertino254');
  });

  it('translates unconfirmed operation errors to a cleaner operation message', () => {
    expect(
      translateRdaJobError('Step failed: 08-verify-withdraw-result (No clear success signal detected after descarga submit)', {
        usuario: 'player_1',
        operacion: 'descarga'
      })
    ).toBe('No se pudo confirmar la operacion descarga para el usuario player_1');
  });
});
