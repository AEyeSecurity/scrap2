import { describe, expect, it } from 'vitest';
import { AsnUserCheckError } from '../src/asn-user-check';
import {
  formatAsnUserNotFoundMessage,
  isAsnUserNotFoundError,
  toFriendlyAsnUserError
} from '../src/asn-user-error';

describe('asn-user-error', () => {
  it('formats the standard ASN user not found message', () => {
    expect(formatAsnUserNotFoundMessage('pepito123')).toBe('No se ha encontrado el usuario pepito123');
  });

  it('translates the ugly goto-user-cd selector failure into a friendly message', () => {
    const usuario = 'pepito123';
    const error = new Error(
      'Step failed: 02-goto-user-cd (No visible element found for selector: text=/Saldo\\s+disponible\\s+actual|Cargar\\s+Saldo|Descargar\\s+Saldo|Importe\\s*:|Cargar/i)'
    );

    expect(isAsnUserNotFoundError(usuario, error)).toBe(true);
    expect(toFriendlyAsnUserError(usuario, error)?.message).toBe('No se ha encontrado el usuario pepito123');
  });

  it('translates ASN user check NOT_FOUND errors', () => {
    const error = new AsnUserCheckError('NOT_FOUND', 'El usuario no existe');

    expect(isAsnUserNotFoundError('missing_user', error)).toBe(true);
    expect(toFriendlyAsnUserError('missing_user', error)?.message).toBe('No se ha encontrado el usuario missing_user');
  });

  it('translates row lookup failures for the requested username', () => {
    const usuario = 'missing_user';
    const error = new Error('Could not find a unique row for user "missing_user"');

    expect(isAsnUserNotFoundError(usuario, error)).toBe(true);
    expect(toFriendlyAsnUserError(usuario, error)?.message).toBe('No se ha encontrado el usuario missing_user');
  });

  it('does not translate unrelated technical failures', () => {
    const error = new Error('Timeout 30000ms exceeded while waiting for navigation');

    expect(isAsnUserNotFoundError('pepito123', error)).toBe(false);
    expect(toFriendlyAsnUserError('pepito123', error)).toBeNull();
  });
});
