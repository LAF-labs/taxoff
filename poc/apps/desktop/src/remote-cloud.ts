import { CLOUD_ORIGIN, CLOUD_WS_HOST, EgressError, type CloudMethod, type Egress } from '@sax/net';
import type { AccountClient, AccountLogin, CloudPorts, DeviceAuth, DocServerEntry, DocsClient, DocsPage, PcLinkRequest, RelayHttpClient, ServerDevice, SharePage, ShareServerRow, ShareTaskState } from './remote-ports.ts';
import {
  DOC_CHUNK_MAX,
  DOC_MAX_CHUNKS,
  DOC_RECORD_MAX_CHARS,
  SHARE_KINDS,
  SHARE_MAX_BODY_CHARS,
  SHARE_MAX_EPOCH,
  b64url,
  fromB64url,
  relayOrigin,
  relayQueue,
  requestDeviceToken,
  type DeviceListJson,
  type HttpJson,
  type SignedAcctClaim,
  type WebSocketLike,
} from '@sax/remote';

export type { AccountClient, CloudPorts, DeviceAuth, RelayHttpClient } from './remote-ports.ts';

interface CloudPortsOptions {
  egress: Egress;
  env: 'prod' | 'dev';
  dev?: { accountOrigin: string; relayHost: string };
}

class CloudPortError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'CloudPortError';
    this.code = code;
  }
}

const CODE = /^[a-z_]+\.[a-z_]+$/;
const serverCode = (body: unknown): string => {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === 'string' && CODE.test(e) ? e : 'server.unknown';
};
const shape = (): never => {
  throw new CloudPortError('response.shape');
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const B64_KEY32 = /^[A-Za-z0-9+/]{43}=$/;
const str = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const int = (v: unknown): v is number => Number.isSafeInteger(v);
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const REFRESH_TOKEN = /^sxa1\.[A-Za-z0-9_-]{43}$/;
const refreshOk = (v: unknown): v is string => typeof v === 'string' && REFRESH_TOKEN.test(v);

function login(b: unknown): AccountLogin {
  if (!isObj(b) || !str(b.session, 512) || !int(b.expiresInSec)) shape();
  const r = b as { session: string; expiresInSec: number; refreshToken?: unknown; refreshExpiresInSec?: unknown };
  if (r.refreshToken === undefined) return { session: r.session, expiresInSec: r.expiresInSec };
  if (!refreshOk(r.refreshToken) || !int(r.refreshExpiresInSec)) shape();
  return { session: r.session, expiresInSec: r.expiresInSec, refreshToken: r.refreshToken as string, refreshExpiresInSec: r.refreshExpiresInSec as number };
}
const rem = (remember?: boolean) => (remember ? { remember: true } : {});

const SHARE_ID = /^[A-Za-z0-9_-]{22}$/;
const SHARE_BODY = /^[A-Za-z0-9_-]+$/;
const SHARE_TASK_STATES = ['open', 'claimed', 'done', 'cancelled', 'expired'];
const shareId = (v: unknown): string => {
  if (typeof v !== 'string' || !SHARE_ID.test(v)) throw new CloudPortError('request.param_rejected');
  return v;
};
const shareEpochOk = (v: unknown): v is number => int(v) && v >= 0 && v <= SHARE_MAX_EPOCH;
function shareRow(v: unknown): ShareServerRow {
  if (
    !isObj(v) || !int(v.seq) || v.seq < 1 || typeof v.rowId !== 'string' || !SHARE_ID.test(v.rowId) || !(SHARE_KINDS as readonly unknown[]).includes(v.kind) || !shareEpochOk(v.epoch)
    || typeof v.deviceId !== 'string' || !UUID4.test(v.deviceId) || !int(v.at) || typeof v.body !== 'string' || v.body.length > SHARE_MAX_BODY_CHARS || !SHARE_BODY.test(v.body)
  ) shape();
  const r = v as unknown as ShareServerRow;
  return { seq: r.seq, rowId: r.rowId, kind: r.kind, epoch: r.epoch, deviceId: r.deviceId, at: r.at, body: r.body };
}

const DOC_ID = SHARE_ID;
const docId = (v: unknown): string => {
  if (typeof v !== 'string' || !DOC_ID.test(v)) throw new CloudPortError('request.param_rejected');
  return v;
};
const chunkNo = (i: unknown): number => {
  if (!int(i) || i < 0 || i >= DOC_MAX_CHUNKS) throw new CloudPortError('request.param_rejected');
  return i;
};
function docEntry(v: unknown): DocServerEntry {
  if (!isObj(v) || typeof v.docId !== 'string' || !DOC_ID.test(v.docId) || !int(v.seq) || v.seq < 1 || (v.state !== 'ready' && v.state !== 'deleted') || !int(v.rev) || v.rev < 0) shape();
  const r = v as Record<string, unknown>;
  if (!shareEpochOk(r.epoch) || typeof r.deviceId !== 'string' || !UUID4.test(r.deviceId) || !int(r.chunks) || (r.chunks as number) < 1 || (r.chunks as number) > DOC_MAX_CHUNKS) shape();
  const record = r.record;
  if (r.state === 'ready' ? typeof record !== 'string' || record.length > DOC_RECORD_MAX_CHARS || !SHARE_BODY.test(record) : record !== null) shape();
  return { docId: r.docId as string, seq: r.seq as number, state: r.state as DocServerEntry['state'], rev: r.rev as number, epoch: r.epoch as number, deviceId: r.deviceId as string, chunks: r.chunks as number, record: (record as string | null) ?? null };
}

const ISSUE_LOCK_ID = /^[A-Za-z0-9_-]{22,64}$/;
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):[0-9]{1,5}$/;
const DEV_HOST = /^(localhost|127\.0\.0\.1):[0-9]{1,5}$/;

export function cloudPorts(o: CloudPortsOptions): CloudPorts {
  const dev = o.env === 'dev';
  if (dev && (!o.dev || !DEV_ORIGIN.test(o.dev.accountOrigin) || !DEV_HOST.test(o.dev.relayHost))) throw new CloudPortError('config.cloud_dev');
  if (!dev && o.dev) throw new CloudPortError('config.cloud_dev');
  const accountOrigin = dev ? o.dev!.accountOrigin : CLOUD_ORIGIN;
  const relayHttpOrigin = dev ? relayOrigin(o.dev!.relayHost, true) : CLOUD_ORIGIN;
  const relayHost = dev ? o.dev!.relayHost : CLOUD_WS_HOST;

  async function call(method: CloudMethod, url: string, ok: readonly number[], x: { headers?: Record<string, string>; body?: unknown } = {}): Promise<unknown> {
    let r;
    try {
      r = await o.egress.cloud({ method, url, headers: x.headers, body: x.body === undefined ? undefined : JSON.stringify(x.body) });
    } catch (e) {
      throw new CloudPortError(e instanceof EgressError ? `net.${e.code}` : 'net.network');
    }
    if (!ok.includes(r.status)) throw new CloudPortError(serverCode(r.json));
    return r.json;
  }
  const bearer = (session: string) => {
    if (!str(session, 512)) throw new CloudPortError('account.unauthorized');
    return { authorization: `Bearer ${session}` };
  };
  const authed = async (auth: DeviceAuth, method: CloudMethod, url: string): Promise<Record<string, string>> => ({ ...(await auth(method, url)) });
  const bytes = (b: Uint8Array, n: number) => {
    if (!(b instanceof Uint8Array) || b.length !== n) throw new CloudPortError('request.param_rejected');
    return b64url(b);
  };

  const httpJson: HttpJson = async (req) => {
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.toLowerCase() !== 'content-type'));
    try {
      const r = await o.egress.cloud({ method: req.method as CloudMethod, url: req.url, headers, body: req.body });
      return { status: r.status, body: r.json };
    } catch (e) {
      throw new CloudPortError(e instanceof EgressError ? `net.${e.code}` : 'net.network');
    }
  };

  const pinnedList = (b: unknown): { aikPub: string | null; deviceList: DeviceListJson | null } => {
    if (!isObj(b) || !(b.aikPub === null || str(b.aikPub, 64)) || !(b.deviceList === null || isObj(b.deviceList))) shape();
    const r = b as { aikPub: string | null; deviceList: DeviceListJson | null };
    return { aikPub: r.aikPub, deviceList: r.deviceList };
  };
  const serverDevices = (b: unknown): ServerDevice[] => {
    if (!isObj(b) || !Array.isArray(b.devices) || b.devices.length > 64) shape();
    return ((b as { devices: unknown[] }).devices).map((d): ServerDevice => {
      if (!isObj(d) || !str(d.deviceId, 36) || !str(d.name, 40) || !str(d.Sx, 64) || !str(d.Vx, 64) || !int(d.registeredAt)) shape();
      const x = d as Record<string, unknown>;
      if (x.role !== 'desktop' && x.role !== 'mobile') shape();
      if (!['windows', 'macos', 'ios', 'android'].includes(x.platform as string) || !['pending', 'active', 'suspended', 'revoked'].includes(x.state as string)) shape();
      if (!(x.deleteAfter === null || x.deleteAfter === undefined || int(x.deleteAfter))) shape();
      if (!(x.lastSeenAt === null || x.lastSeenAt === undefined || int(x.lastSeenAt))) shape();
      return { deviceId: x.deviceId as string, role: x.role as ServerDevice['role'], platform: x.platform as ServerDevice['platform'], name: x.name as string, state: x.state as ServerDevice['state'], registeredAt: x.registeredAt as number, Sx: x.Sx as string, Vx: x.Vx as string, deleteAfter: (x.deleteAfter as number | null | undefined) ?? null, lastSeenAt: (x.lastSeenAt as number | null | undefined) ?? null };
    });
  };
  const linkUrl = (deviceId: string) => {
    if (typeof deviceId !== 'string' || !UUID4.test(deviceId)) throw new CloudPortError('request.param_rejected');
    return `${accountOrigin}/v1/pc-links/${deviceId}`;
  };

  const account: AccountClient = {
    async startEmailCode(email) {
      const b = await call('POST', `${accountOrigin}/v1/auth/code`, [200], { body: { email } });
      if (!isObj(b) || !str(b.loginId, 256) || !int(b.expiresInSec)) shape();
      const r = b as { loginId: string; expiresInSec: number };
      return { loginId: r.loginId, expiresInSec: r.expiresInSec };
    },
    async verifyEmailCode(loginId, code, remember) {
      return login(await call('POST', `${accountOrigin}/v1/auth/code/verify`, [200], { body: { loginId, code, ...rem(remember) } }));
    },
    async refresh(refreshToken) {
      if (!refreshOk(refreshToken)) throw new CloudPortError('account.unauthorized');
      const r = login(await call('POST', `${accountOrigin}/v1/auth/refresh`, [200], { body: { refreshToken } }));
      if (r.refreshToken === undefined) shape();
      return r as Required<AccountLogin>;
    },
    async revokeRefresh(refreshToken) {
      if (!refreshOk(refreshToken)) return;
      await call('POST', `${accountOrigin}/v1/auth/refresh/revoke`, [204], { body: { refreshToken } });
    },
    async logoutAll(session) {
      await call('POST', `${accountOrigin}/v1/auth/logout-all`, [204], { headers: bearer(session), body: {} });
    },
    async logout(session) {
      await call('POST', `${accountOrigin}/v1/auth/logout`, [200, 204], { headers: bearer(session), body: {} });
    },
    async deviceList(session) {
      return pinnedList(await call('GET', `${accountOrigin}/v1/device-list`, [200], { headers: bearer(session) }));
    },
    async deviceListByDevice(auth) {
      const url = `${accountOrigin}/v1/device-list`;
      return pinnedList(await call('GET', url, [200], { headers: await authed(auth, 'GET', url) }));
    },
    async pinFirstDesktop(session, x) {
      const b = await call('POST', `${accountOrigin}/v1/aik`, [201], { headers: bearer(session), body: { aikPub: x.aikPub, deviceList: x.deviceList, platform: x.platform, name: x.name, ...(x.escrow ? { escrow: x.escrow } : {}) } });
      if (!isObj(b) || !str(b.deviceId, 64)) shape();
      return { deviceId: (b as { deviceId: string }).deviceId };
    },
    async deviceToken(cert, dpop, scopes, model) {
      try {
        const extra = { ...(scopes ? { scopes: [...scopes] } : {}), ...(model ? { model: model.slice(0, 40) } : {}) };
        const http: HttpJson = Object.keys(extra).length ? (req) => httpJson({ ...req, body: JSON.stringify({ ...(JSON.parse(req.body!) as object), ...extra }) }) : httpJson;
        return await requestDeviceToken(http, accountOrigin, cert, dpop);
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        throw new CloudPortError(typeof code === 'string' && (CODE.test(code) || code === 'response.shape') ? code : 'server.unknown');
      }
    },
    async billing(auth) {
      const su = `${accountOrigin}/v1/billing/subscription`;
      const sr = await call('GET', su, [200], { headers: await authed(auth, 'GET', su) });
      const s = (isObj(sr) ? sr : {}) as Record<string, unknown>;
      const e = (isObj(s.entitlement) ? s.entitlement : {}) as Record<string, unknown>;
      if (!['trial', 'paid', 'none'].includes(e.state as string) || !(e.until === null || int(e.until))) shape();
      if (!(s.subscription === null || isObj(s.subscription))) shape();
      const sub = s.subscription as Record<string, unknown> | null;
      if (sub && (!['pending', 'active', 'past_due', 'canceled'].includes(sub.status as string) || !(sub.renewAt === null || int(sub.renewAt)) || !int(sub.amountKrw))) shape();
      const rf = sub && isObj(sub.refund) ? (sub.refund as Record<string, unknown>) : null;
      if (rf && (!int(rf.refundableUntil) || !int(rf.amountKrw))) shape();
      return {
        entitlement: { state: e.state as 'trial' | 'paid' | 'none', until: e.until as number | null },
        subscription: sub ? { status: sub.status as 'pending' | 'active' | 'past_due' | 'canceled', renewAt: sub.renewAt as number | null, amountKrw: sub.amountKrw as number, refund: rf ? { refundableUntil: rf.refundableUntil as number, amountKrw: rf.amountKrw as number } : null } : null,
      };
    },
    async billingCheckout(auth) {
      const url = `${accountOrigin}/v1/billing/checkout`;
      const b = (await call('POST', url, [200], { headers: await authed(auth, 'POST', url) })) as Record<string, unknown> | null;
      if (!isObj(b) || !str(b.checkoutUrl, 512) || !(b.checkoutUrl as string).startsWith(`${accountOrigin}/v1/billing/card?ref=`)) shape();
      return { checkoutUrl: (b as Record<string, unknown>).checkoutUrl as string };
    },
    async billingCancel(auth) {
      const url = `${accountOrigin}/v1/billing/cancel`;
      await call('POST', url, [204], { headers: await authed(auth, 'POST', url) });
    },
    async billingRefund(auth) {
      const url = `${accountOrigin}/v1/billing/refund`;
      const b = (await call('POST', url, [200], { headers: await authed(auth, 'POST', url) })) as Record<string, unknown> | null;
      if (!isObj(b) || !int(b.amountKrw)) shape();
      return { amountKrw: (b as Record<string, unknown>).amountKrw as number };
    },
    async acctClaim(auth) {
      const url = `${accountOrigin}/v1/acct-claim`;
      const b = await call('GET', url, [200], { headers: await authed(auth, 'GET', url) });
      if (!isObj(b) || !isObj(b.claim) || !str(b.sig, 128)) shape();
      const c = (b as { claim: Record<string, unknown> }).claim;
      if (!str(c.account_id, 128) || !str(c.email, 254) || !str(c.aik_pub, 64) || !int(c.iat) || !int(c.exp)) shape();
      return b as unknown as SignedAcctClaim;
    },
    async enrollPhone(auth, x) {
      const url = `${accountOrigin}/v1/devices/enroll`;
      await call('POST', url, [200, 201], { headers: await authed(auth, 'POST', url), body: { deviceId: x.deviceId, role: x.role, platform: x.platform, name: x.name, Sx: x.Sx, Vx: x.Vx, roomId: x.roomId } });
    },
    async putDeviceList(auth, list) {
      const url = `${accountOrigin}/v1/device-list`;
      await call('PUT', url, [200], { headers: await authed(auth, 'PUT', url), body: { deviceList: list } });
    },
    async devices(auth) {
      const url = `${accountOrigin}/v1/devices`;
      return serverDevices(await call('GET', url, [200], { headers: await authed(auth, 'GET', url) }));
    },
    async devicesBySession(session) {
      return serverDevices(await call('GET', `${accountOrigin}/v1/devices`, [200], { headers: bearer(session) }));
    },
    async enrollDesktop(session, x) {
      await call('POST', `${accountOrigin}/v1/devices/enroll`, [201], { headers: bearer(session), body: { deviceId: x.deviceId, role: 'desktop', platform: x.platform, name: x.name, Sx: x.Sx, Vx: x.Vx } });
    },
    async pcLinkHello(session, deviceId, hello) {
      await call('PUT', linkUrl(deviceId), [204], { headers: bearer(session), body: { hello } });
    },
    async pcLinkAnswer(session, deviceId) {
      const b = await call('GET', linkUrl(deviceId), [200], { headers: bearer(session) });
      if (!isObj(b) || !('challenge' in b) || !('grant' in b)) shape();
      const r = b as { challenge: unknown; grant: unknown };
      return { challenge: r.challenge ?? null, grant: r.grant ?? null };
    },
    async pcLinkReveal(session, deviceId, reveal) {
      await call('POST', `${linkUrl(deviceId)}/reveal`, [204], { headers: bearer(session), body: { reveal } });
    },
    async pcLinkCancel(session, deviceId) {
      await call('DELETE', linkUrl(deviceId), [204], { headers: bearer(session) });
    },
    async keyEscrowState(auth) {
      const url = `${accountOrigin}/v1/key-escrow`;
      const b = await call('GET', url, [200], { headers: await authed(auth, 'GET', url) });
      if (!isObj(b) || !str(b.pub, 44) || !B64_KEY32.test(b.pub) || typeof b.stored !== 'boolean') shape();
      return { pub: (b as { pub: string }).pub, stored: (b as { stored: boolean }).stored };
    },
    async putKeyEscrow(auth, sealed) {
      const url = `${accountOrigin}/v1/key-escrow`;
      await call('PUT', url, [204], { headers: await authed(auth, 'PUT', url), body: { enc: sealed.enc, ct: sealed.ct } });
    },
    async claimKeyEscrow(session, x) {
      const b = await call('POST', `${accountOrigin}/v1/key-escrow/claim`, [200], { headers: bearer(session), body: { deviceId: x.deviceId, Hx: x.Hx } });
      if (!isObj(b) || !str(b.aikPub, 44) || !B64_KEY32.test(b.aikPub) || !str(b.enc, 44) || !B64_KEY32.test(b.enc) || !str(b.ct, 64) || !/^[A-Za-z0-9+/]{64}$/.test(b.ct)) shape();
      const r = b as { aikPub: string; enc: string; ct: string };
      return { aikPub: r.aikPub, enc: r.enc, ct: r.ct };
    },
    async joinDevice(session, deviceId, list) {
      await call('POST', `${accountOrigin}/v1/devices/join`, [200], { headers: bearer(session), body: { deviceId, deviceList: list } });
    },
    async keyEscrowOff(auth, op) {
      const url = `${accountOrigin}/v1/key-escrow/off`;
      await call('POST', url, [204], { headers: await authed(auth, 'POST', url), body: op });
    },
    async putRecovery(auth, blob) {
      const url = `${accountOrigin}/v1/recovery`;
      await call('PUT', url, [204], { headers: await authed(auth, 'PUT', url), body: { blob } });
    },
    async recovery(who) {
      const url = `${accountOrigin}/v1/recovery`;
      const b = await call('GET', url, [200], { headers: typeof who === 'string' ? bearer(who) : await authed(who, 'GET', url) });
      if (!isObj(b) || !str(b.aikPub, 44) || !B64_KEY32.test(b.aikPub) || !str(b.blob, 268) || !/^[A-Za-z0-9+/]+={0,2}$/.test(b.blob) || !int(b.setAt)) shape();
      const r = b as { aikPub: string; blob: string; setAt: number };
      return { aikPub: r.aikPub, blob: r.blob, setAt: r.setAt };
    },
    async deleteRecovery(auth) {
      const url = `${accountOrigin}/v1/recovery`;
      await call('DELETE', url, [204], { headers: await authed(auth, 'DELETE', url) });
    },
    async putUnlockShare(auth, se) {
      const url = `${accountOrigin}/v1/unlock-email/share`;
      await call('PUT', url, [204], { headers: await authed(auth, 'PUT', url), body: { se } });
    },
    async deleteUnlockShare(auth) {
      const url = `${accountOrigin}/v1/unlock-email/share`;
      await call('DELETE', url, [204], { headers: await authed(auth, 'DELETE', url) });
    },
    async startUnlockEmail(auth) {
      const url = `${accountOrigin}/v1/unlock-email/code`;
      const b = await call('POST', url, [200], { headers: await authed(auth, 'POST', url), body: {} });
      if (!isObj(b) || !str(b.unlockId, 256) || !int(b.expiresInSec)) shape();
      const r = b as { unlockId: string; expiresInSec: number };
      return { unlockId: r.unlockId, expiresInSec: r.expiresInSec };
    },
    async finishUnlockEmail(auth, x) {
      const url = `${accountOrigin}/v1/unlock-email/verify`;
      const b = await call('POST', url, [200], { headers: await authed(auth, 'POST', url), body: { unlockId: x.unlockId, code: x.code, Tx: x.Tx } });
      if (!isObj(b) || !str(b.enc, 44) || !B64_KEY32.test(b.enc) || !str(b.ct, 64) || !/^[A-Za-z0-9+/]{64}$/.test(b.ct)) shape();
      const r = b as { enc: string; ct: string };
      return { enc: r.enc, ct: r.ct };
    },
    async keyEscrowPub(session) {
      const b = await call('GET', `${accountOrigin}/v1/key-escrow/pub`, [200], { headers: bearer(session) });
      if (!isObj(b) || !str(b.pub, 44) || !B64_KEY32.test(b.pub)) shape();
      return { pub: (b as { pub: string }).pub };
    },
    async resetByKeyEscrow(session, x) {
      await call('POST', `${accountOrigin}/v1/key-escrow/reset`, [200], { headers: bearer(session), body: { deviceId: x.deviceId, aikPub: x.aikPub, deviceList: x.deviceList, enc: x.enc, ct: x.ct } });
    },
    async pcLinks(auth) {
      const url = `${accountOrigin}/v1/pc-links`;
      const b = await call('GET', url, [200], { headers: await authed(auth, 'GET', url) });
      if (!isObj(b) || !Array.isArray(b.links) || b.links.length > 16) shape();
      return ((b as { links: unknown[] }).links).map((l): PcLinkRequest => {
        if (!isObj(l) || !str(l.deviceId, 36) || !UUID4.test(l.deviceId) || !str(l.name, 40) || !int(l.createdAt) || !isObj(l.hello)) shape();
        const x = l as Record<string, unknown>;
        if (x.platform !== 'windows' && x.platform !== 'macos') shape();
        if (!(x.challengedBy === null || (str(x.challengedBy, 36) && UUID4.test(x.challengedBy)))) shape();
        return { deviceId: x.deviceId as string, name: x.name as string, platform: x.platform as PcLinkRequest['platform'], createdAt: x.createdAt as number, hello: x.hello, challengedBy: x.challengedBy as string | null, reveal: x.reveal ?? null };
      });
    },
    async pcLinkChallenge(auth, deviceId, challenge) {
      const url = `${linkUrl(deviceId)}/challenge`;
      await call('POST', url, [204], { headers: await authed(auth, 'POST', url), body: { challenge } });
    },
    async pcLinkGrant(auth, deviceId, grant) {
      const url = `${linkUrl(deviceId)}/grant`;
      await call('POST', url, [204], { headers: await authed(auth, 'POST', url), body: { grant } });
    },
    async pcLinkDrop(auth, deviceId) {
      const url = linkUrl(deviceId);
      await call('DELETE', url, [204], { headers: await authed(auth, 'DELETE', url) });
    },
    async issueLock(auth) {
      const url = `${accountOrigin}/v1/issue-lock`;
      const b = await call('GET', url, [200], { headers: await authed(auth, 'GET', url) });
      if (!isObj(b) || typeof b.held !== 'boolean' || typeof b.mine !== 'boolean' || !(b.deviceId === null || typeof b.deviceId === 'string') || !(b.expiresAt === null || int(b.expiresAt))) shape();
      const r = b as { held: boolean; deviceId: string | null; expiresAt: number | null; mine: boolean };
      return { held: r.held, deviceId: r.deviceId, expiresAt: r.expiresAt, mine: r.mine };
    },
    async acquireIssueLock(auth) {
      const url = `${accountOrigin}/v1/issue-lock/acquire`;
      const b = await call('POST', url, [200], { headers: await authed(auth, 'POST', url), body: {} });
      if (!isObj(b) || typeof b.lockId !== 'string' || !ISSUE_LOCK_ID.test(b.lockId) || !int(b.expiresAt)) shape();
      const r = b as { lockId: string; expiresAt: number };
      return { lockId: r.lockId, expiresAt: r.expiresAt };
    },
    async renewIssueLock(auth, lockId) {
      const url = `${accountOrigin}/v1/issue-lock/renew`;
      const b = await call('POST', url, [200], { headers: await authed(auth, 'POST', url), body: { lockId } });
      if (!isObj(b) || !int(b.expiresAt)) shape();
      return { expiresAt: (b as { expiresAt: number }).expiresAt };
    },
    async releaseIssueLock(auth, lockId) {
      const url = `${accountOrigin}/v1/issue-lock/release`;
      await call('POST', url, [204], { headers: await authed(auth, 'POST', url), body: { lockId } });
    },
    async wakePhone(auth, deviceId, kind) {
      if (!UUID4.test(deviceId) || (kind !== 'approve' && kind !== 'update' && kind !== 'unlock')) throw new CloudPortError('request.param_rejected');
      const url = `${accountOrigin}/v1/wake`;
      const b = await call('POST', url, [202], { headers: await authed(auth, 'POST', url), body: { deviceId, kind } });
      if (!isObj(b) || typeof b.sent !== 'boolean') shape();
      return { sent: (b as { sent: boolean }).sent };
    },
    async sendInvoiceMail(auth, m) {
      if (!(m.pdf instanceof Uint8Array) || !m.pdf.length) throw new CloudPortError('request.param_rejected');
      const url = `${accountOrigin}/v1/invoice-mail`;
      const body = { to: m.to, ...(m.supplierEmail ? { supplierEmail: m.supplierEmail } : {}), supplierName: m.supplierName, buyerName: m.buyerName, approvalNo: m.approvalNo, issueDate: m.issueDate, total: m.total, pdf: Buffer.from(m.pdf).toString('base64') };
      const b = await call('POST', url, [202], { headers: await authed(auth, 'POST', url), body });
      if (!isObj(b) || b.sent !== true) shape();
    },
    async putShareRow(auth, row) {
      const url = `${accountOrigin}/v1/share/rows/${shareId(row.rowId)}`;
      const body = { kind: row.kind, epoch: row.epoch, body: row.body, ...(row.taskId === undefined ? {} : { taskId: shareId(row.taskId) }) };
      const b = await call('PUT', url, [200], { headers: await authed(auth, 'PUT', url), body });
      if (!isObj(b) || !int(b.seq) || b.seq < 1) shape();
      return { seq: (b as { seq: number }).seq };
    },
    async shareRows(auth, after) {
      if (!int(after) || after < 0) throw new CloudPortError('request.param_rejected');
      const url = after === 0 ? `${accountOrigin}/v1/share/rows` : `${accountOrigin}/v1/share/rows/after/${after}`;
      const b = await call('GET', url, [200], { headers: await authed(auth, 'GET', url) });
      if (!isObj(b) || !Array.isArray(b.rows) || b.rows.length > 200 || !int(b.head) || b.head < 0 || !shareEpochOk(b.epoch) || typeof b.more !== 'boolean') shape();
      const r = b as { rows: unknown[]; head: number; epoch: number; more: boolean };
      const rows = r.rows.map(shareRow);
      let last = after;
      for (const x of rows) {
        if (x.seq <= last) shape();
        last = x.seq;
      }
      return { rows, head: r.head, epoch: r.epoch, more: r.more } satisfies SharePage;
    },
    async shareTasks(auth) {
      const url = `${accountOrigin}/v1/share/tasks`;
      const b = await call('GET', url, [200], { headers: await authed(auth, 'GET', url) });
      if (!isObj(b) || !Array.isArray(b.tasks)) shape();
      return (b as { tasks: unknown[] }).tasks.map((t): ShareTaskState => {
        if (
          !isObj(t) || typeof t.taskId !== 'string' || !SHARE_ID.test(t.taskId) || !SHARE_TASK_STATES.includes(t.state as string) || typeof t.createdBy !== 'string' || !UUID4.test(t.createdBy)
          || !(t.claimedBy === null || (typeof t.claimedBy === 'string' && UUID4.test(t.claimedBy))) || !(t.claimExpiresAt === null || int(t.claimExpiresAt)) || !int(t.createdAt) || !int(t.updatedAt)
        ) shape();
        const x = t as unknown as ShareTaskState;
        return { taskId: x.taskId, state: x.state, createdBy: x.createdBy, claimedBy: x.claimedBy, claimExpiresAt: x.claimExpiresAt, createdAt: x.createdAt, updatedAt: x.updatedAt };
      });
    },
    async claimShareTask(auth, taskId) {
      const url = `${accountOrigin}/v1/share/tasks/${shareId(taskId)}/claim`;
      const b = await call('POST', url, [200], { headers: await authed(auth, 'POST', url), body: {} });
      if (!isObj(b) || !int(b.claimExpiresAt)) shape();
      return { claimExpiresAt: (b as { claimExpiresAt: number }).claimExpiresAt };
    },
    async releaseShareTask(auth, taskId) {
      const url = `${accountOrigin}/v1/share/tasks/${shareId(taskId)}/release`;
      await call('POST', url, [204], { headers: await authed(auth, 'POST', url), body: {} });
    },
    async cancelShareTask(auth, taskId) {
      const url = `${accountOrigin}/v1/share/tasks/${shareId(taskId)}/cancel`;
      await call('POST', url, [204], { headers: await authed(auth, 'POST', url), body: {} });
    },
    async leaveDevice(auth) {
      const url = `${accountOrigin}/v1/devices/self/leave`;
      await call('POST', url, [204], { headers: await authed(auth, 'POST', url), body: {} });
    },
    async accountDeletion(auth) {
      const url = `${accountOrigin}/v1/account/deletion`;
      const b = await call('GET', url, [200], { headers: await authed(auth, 'GET', url) });
      if (!isObj(b) || !(b.deleteAfter === null || int(b.deleteAfter))) shape();
      return { deleteAfter: (b as { deleteAfter: number | null }).deleteAfter };
    },
    async requestAccountDelete(auth) {
      const url = `${accountOrigin}/v1/account/delete-request`;
      const b = await call('POST', url, [202], { headers: await authed(auth, 'POST', url), body: {} });
      if (!isObj(b) || !int(b.deleteAfter)) shape();
      return { deleteAfter: (b as { deleteAfter: number }).deleteAfter };
    },
    async cancelAccountDelete(auth) {
      const url = `${accountOrigin}/v1/account/delete-cancel`;
      await call('POST', url, [204], { headers: await authed(auth, 'POST', url), body: {} });
    },
  };

  const docUrl = (id: string) => `${accountOrigin}/v1/docs/${docId(id)}`;
  const docs: DocsClient = {
    async start(auth, id, size) {
      const url = docUrl(id);
      if (!int(size.chunks) || !int(size.blobBytes)) throw new CloudPortError('request.param_rejected');
      await call('POST', url, [200], { headers: await authed(auth, 'POST', url), body: { chunks: size.chunks, blobBytes: size.blobBytes } });
    },
    async putChunk(auth, id, i, data) {
      if (!(data instanceof Uint8Array) || !data.length || data.length > DOC_CHUNK_MAX) throw new CloudPortError('request.param_rejected');
      const url = `${docUrl(id)}/chunks/${chunkNo(i)}`;
      await call('PUT', url, [204], { headers: await authed(auth, 'PUT', url), body: { data: b64url(data) } });
    },
    async putRecord(auth, w) {
      const url = `${docUrl(w.docId)}/record`;
      const b = await call('PUT', url, [200], { headers: await authed(auth, 'PUT', url), body: { rev: w.rev, epoch: w.epoch, record: w.record } });
      if (!isObj(b) || !int(b.seq) || b.seq < 1) shape();
      return { seq: (b as { seq: number }).seq };
    },
    async list(auth, after) {
      if (!int(after) || after < 0) throw new CloudPortError('request.param_rejected');
      const url = after === 0 ? `${accountOrigin}/v1/docs` : `${accountOrigin}/v1/docs/after/${after}`;
      const b = await call('GET', url, [200], { headers: await authed(auth, 'GET', url) });
      if (!isObj(b) || !Array.isArray(b.docs) || b.docs.length > 200 || !int(b.head) || b.head < 0 || typeof b.more !== 'boolean') shape();
      const r = b as { docs: unknown[]; head: number; more: boolean };
      const list = r.docs.map(docEntry);
      let last = after;
      for (const x of list) {
        if (x.seq <= last) shape();
        last = x.seq;
      }
      return { docs: list, head: r.head, more: r.more } satisfies DocsPage;
    },
    async getChunk(auth, id, i) {
      const url = `${docUrl(id)}/chunks/${chunkNo(i)}`;
      const b = await call('GET', url, [200], { headers: await authed(auth, 'GET', url) });
      if (!isObj(b) || typeof b.data !== 'string' || !SHARE_BODY.test(b.data)) shape();
      const data = fromB64url((b as { data: string }).data);
      if (!data.length || data.length > DOC_CHUNK_MAX) shape();
      return data;
    },
    async remove(auth, id) {
      const url = docUrl(id);
      await call('DELETE', url, [204], { headers: await authed(auth, 'DELETE', url) });
    },
  };

  const relay: RelayHttpClient = {
    async createRoom(auth, roomId) {
      const url = `${relayHttpOrigin}/v1/rooms`;
      const id = bytes(roomId, 16);
      const b = await call('POST', url, [201], { headers: await authed(auth, 'POST', url), body: { roomId: id } });
      if (!isObj(b) || !int(b.expiresAt)) shape();
      return { expiresAt: (b as { expiresAt: number }).expiresAt };
    },
    async registerMailbox(auth, mbxId, tokRead, tokWrite, peer) {
      const url = `${relayHttpOrigin}/v1/mailboxes`;
      const body = { mbxId: bytes(mbxId, 32), tokRead: bytes(tokRead, 32), tokWrite: bytes(tokWrite, 32), ...(peer ? { peer } : {}) };
      await call('POST', url, [201], { headers: await authed(auth, 'POST', url), body });
    },
    async deleteMailbox(auth, mbxId, tokWrite, peer) {
      const url = `${relayHttpOrigin}/v1/mailboxes/${bytes(mbxId, 32)}`;
      await call('DELETE', url, [204], { headers: { ...(await authed(auth, 'DELETE', url)), 'x-mbx-write': bytes(tokWrite, 32), ...(peer ? { 'x-mbx-peer': peer } : {}) } });
    },
  };

  return {
    account,
    relay,
    docs,
    relayHost,
    accountOrigin,
    insecureLocal: dev,
    mailboxQueue(mbxId, tok, auth) {
      return relayQueue({ http: httpJson, origin: relayHttpOrigin, mbxId, tok, deviceAuth: (htm, htu) => auth(htm, htu) });
    },
    openSocket(url, headers) {
      try {
        return o.egress.openCloudSocket(url, headers) as unknown as WebSocketLike;
      } catch (e) {
        throw new CloudPortError(e instanceof EgressError ? `net.${e.code}` : 'net.network');
      }
    },
  };
}
