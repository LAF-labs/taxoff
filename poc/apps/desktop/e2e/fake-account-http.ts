import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AccountClient } from '../dist/remote-ports.js';

type Route = (c: AccountClient, b: Record<string, unknown>, session: string) => Promise<[number, unknown]>;

const R: Record<string, Route> = {
  'POST /v1/auth/code': async (c, b) => [200, await c.startEmailCode(String(b.email))],
  'POST /v1/auth/code/verify': async (c, b) => [200, await c.verifyEmailCode(String(b.loginId), String(b.code), b.remember === true)],
  'POST /v1/auth/logout': async (c, _b, s) => (await c.logout(s), [204, null]),
  'POST /v1/auth/logout-all': async (c, _b, s) => (await c.logoutAll(s), [204, null]),
  'GET /v1/device-list': async (c, _b, s) => [200, await c.deviceList(s)],
  'POST /v1/aik': async (c, b, s) => [201, await c.pinFirstDesktop(s, b as never)],
  'POST /v1/auth/refresh': async (c, b) => [200, await c.refresh(String(b.refreshToken))],
  'POST /v1/auth/refresh/revoke': async (c, b) => (await c.revokeRefresh(String(b.refreshToken)), [204, null]),
};

export async function serveAccount(client: AccountClient): Promise<{ origin: string; hits: string[]; close(): void }> {
  const hits: string[] = [];
  const srv = http.createServer((req, res) => {
    const key = `${req.method} ${req.url}`;
    hits.push(key);
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      const route = R[key];
      const send = (status: number, body: unknown) => {
        if (body === null) return void res.writeHead(status).end();
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      };
      if (!route) return send(404, { error: 'request.not_found' });
      let body: Record<string, unknown>;
      try {
        body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
      } catch {
        return send(400, { error: 'request.param_rejected' });
      }
      const session = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      route(client, body, session).then(
        ([status, b]) => send(status, b),
        (e: { code?: string }) => send(e.code === 'account.unauthorized' ? 401 : 400, { error: e.code ?? 'server.unknown' }),
      );
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, hits, close: () => srv.close() };
}
