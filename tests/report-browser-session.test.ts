import { describe, expect, it, vi } from 'vitest';
import { RunAuthenticatedReportSessionManager } from '../src/report-browser-session';

describe('credential-scoped authenticated report sessions', () => {
  it('reuses one login per exact credential in a run and closes every distinct session', async () => {
    const manager = new RunAuthenticatedReportSessionManager(
      {} as any,
      { child: vi.fn() } as any,
      {} as any
    );
    const sessions = new Map<string, any>();
    const createSession = vi.spyOn(manager as any, 'createSession').mockImplementation(async (lease: any) => {
      const session = {
        runId: lease.runId,
        ownerId: lease.ownerId,
        pagina: lease.pagina,
        browser: { close: vi.fn(async () => undefined) },
        context: { close: vi.fn(async () => undefined) }
      };
      sessions.set(`${lease.ownerId}:${lease.loginUsername}`, session);
      return session;
    });
    const lease = {
      runId: 'run-1', ownerId: 'owner-1', pagina: 'ASN',
      loginUsername: 'shared-login', loginPassword: 'shared-password'
    } as any;

    await manager.withSession(lease, async () => undefined);
    await manager.withSession({ ...lease, itemId: 'item-2' }, async () => undefined);
    await manager.withSession({ ...lease, ownerId: 'owner-2', itemId: 'item-3' }, async () => undefined);
    await manager.withSession({
      ...lease,
      ownerId: 'owner-3',
      loginUsername: 'other-login',
      loginPassword: 'other-password',
      itemId: 'item-4'
    }, async () => undefined);

    expect(createSession).toHaveBeenCalledTimes(2);
    await manager.closeRun('run-1');
    expect(sessions.get('owner-1:shared-login').context.close).toHaveBeenCalledOnce();
    expect(sessions.get('owner-1:shared-login').browser.close).toHaveBeenCalledOnce();
    expect(sessions.get('owner-3:other-login').context.close).toHaveBeenCalledOnce();
    expect(sessions.get('owner-3:other-login').browser.close).toHaveBeenCalledOnce();
  });
});
