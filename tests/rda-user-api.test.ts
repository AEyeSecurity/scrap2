import { describe, expect, it } from 'vitest';
import { RdaUserApiError, normalizeRdaUsername, selectExactRdaUser } from '../src/rda-user-api';

describe('rda-user-api', () => {
  it('selects only the exact normalized username when prefix matches also exist', () => {
    const selected = selectExactRdaUser(
      [
        { id: 44611, username: '3nico3951', balance: 0, role: '0' },
        { id: 42775, username: '3nico395', balance: 6, role: '0' }
      ],
      '3nico395'
    );

    expect(selected).toMatchObject({
      id: '42775',
      username: '3nico395',
      balance: 6
    });
  });

  it('throws NOT_FOUND when the API response has no exact match', () => {
    expect(() => selectExactRdaUser([{ id: 44611, username: '3nico3951', balance: 0 }], '3nico395')).toThrow(
      RdaUserApiError
    );

    try {
      selectExactRdaUser([{ id: 44611, username: '3nico3951', balance: 0 }], '3nico395');
      throw new Error('expected selectExactRdaUser to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RdaUserApiError);
      expect((error as RdaUserApiError).code).toBe('NOT_FOUND');
      expect((error as RdaUserApiError).message).toBe('No se ha encontrado el usuario 3nico395');
    }
  });

  it('throws AMBIGUOUS when more than one exact match exists', () => {
    try {
      selectExactRdaUser(
        [
          { id: 1, username: '3nico395', balance: 0 },
          { id: 2, username: ' 3NICO395 ', balance: '1,00' }
        ],
        '3nico395'
      );
      throw new Error('expected selectExactRdaUser to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RdaUserApiError);
      expect((error as RdaUserApiError).code).toBe('AMBIGUOUS');
    }
  });

  it('normalizes username case, whitespace and diacritics without compacting suffixes', () => {
    expect(normalizeRdaUsername('  Álvaro01  ')).toBe('alvaro01');
    expect(normalizeRdaUsername('3nico3951')).not.toBe(normalizeRdaUsername('3nico395'));
  });
});
