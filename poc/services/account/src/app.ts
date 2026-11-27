import {
  DailySalt,
  DeviceAuth,
  Router,
  S,
  fail,
  json,
  memoryLimits,
  randomToken,
  validator,
  ALL_SCOPES,
  type Ctx,
  type Scope,
  type InternalCheck,
  type DeviceDirectory,
  type TokenVerifier,
  type Limits,
} from '@sax/svc-shared';
import { deviceListSchema, signedCertSchema, signedOpSchema, type AcctOp, type DeviceList, type SignedCert } from './aik.ts';
import { ACCOUNT, DEVICE, DOCS, INVOICE_MAIL, ISSUE_LOCK, MS, KEY_ESCROW, PC_LINK, RECOVERY, SHARE, UNLOCK_EMAIL } from './constants.ts';
import { addDocRoutes, type DocBox } from './docs.ts';
import { pageHeaders } from './pg-toss.ts';
import type { AccountService, AuthMethod, BillingCaller, Session, ShareKind } from './service.ts';

const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });
const b64u = (min: number, max: number) => ({ type: 'string', pattern: `^[A-Za-z0-9_-]{${min},${max}}$` });

const SEALED_KEY = { type: 'string', pattern: '^[A-Za-z0-9+/]{64}$' } as const;
const EMAIL = { type: 'string', minLength: 3, maxLength: 254 } as const;
const REMEMBER = { type: 'boolean' } as const;
const SHARE_ROW_ID = { type: 'string', pattern: '^[A-Za-z0-9_-]{22}$' } as const;
const REFRESH_TOKEN = { type: 'string', pattern: '^sxa1\\.[A-Za-z0-9_-]{43}$' } as const;

const MAIL_ADDRESS = { type: 'string', maxLength: 254, pattern: '^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\\.[A-Za-z]{2,}$' } as const;
const NAME70 = { type: 'string', minLength: 1, maxLength: 70 } as const;

type InvoiceMailBody = { to: string; supplierEmail?: string; supplierName: string; buyerName: string; approvalNo: string; issueDate: string; total: number; pdf: string };

const V = {
  invoiceMail: validator<InvoiceMailBody>(
    obj(
      {
        to: MAIL_ADDRESS,
        supplierEmail: MAIL_ADDRESS,
        supplierName: NAME70,
        buyerName: { type: 'string', maxLength: 70 },
        approvalNo: { type: 'string', pattern: '^[0-9]{8}-?[0-9]{8}-?[0-9]{8}$' },
        issueDate: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
        total: { type: 'integer', minimum: -1e15, maximum: 1e15 },
        pdf: { type: 'string', minLength: 8, maxLength: Math.ceil(INVOICE_MAIL.pdfMaxBytes / 3) * 4, pattern: '^[A-Za-z0-9+/]+={0,2}$' },
      },
      ['to', 'supplierName', 'buyerName', 'approvalNo', 'issueDate', 'total', 'pdf'],
    ),
  ),
  codeStart: validator<{ email: string }>(obj({ email: EMAIL })),
  codeVerify: validator<{ loginId: string; code: string; remember?: boolean }>(obj({ loginId: S.token, code: { type: 'string', pattern: '^[0-9]{6}$' }, remember: REMEMBER }, ['loginId', 'code'])),
  refresh: validator<{ refreshToken: string }>(obj({ refreshToken: REFRESH_TOKEN })),
  authorize: validator<{ client_id: string; redirect_uri: string; code_challenge: string; code_challenge_method: string; state: string }>(
    obj({ client_id: { type: 'string', maxLength: 64 }, redirect_uri: { type: 'string', maxLength: 200 }, code_challenge: b64u(43, 43), code_challenge_method: { const: 'S256' }, state: b64u(16, 128) }),
  ),
  token: validator<{ grant_type: string; code: string; code_verifier: string; redirect_uri: string; client_id: string; remember?: boolean }>(
    obj(
      { grant_type: { const: 'authorization_code' }, code: S.token, code_verifier: { type: 'string', pattern: '^[A-Za-z0-9._~-]{43,128}$' }, redirect_uri: { type: 'string', maxLength: 200 }, client_id: { type: 'string', maxLength: 64 }, remember: REMEMBER },
      ['grant_type', 'code', 'code_verifier', 'redirect_uri', 'client_id'],
    ),
  ),
  passkeyRegister: validator<{ challenge: string; clientDataJSON: string; attestationObject: string }>(obj({ challenge: S.token, clientDataJSON: b64u(1, 6000), attestationObject: b64u(1, 11000) })),
  passkeyLogin: validator<{ challenge: string; credentialId: string; clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string; remember?: boolean }>(
    obj(
      { challenge: S.token, credentialId: b64u(16, 1400), clientDataJSON: b64u(1, 6000), authenticatorData: b64u(37, 1400), signature: b64u(64, 200), userHandle: b64u(1, 100), remember: REMEMBER },
      ['challenge', 'credentialId', 'clientDataJSON', 'authenticatorData', 'signature'],
    ),
  ),
  consent: validator<{ version: string }>(obj({ version: { type: 'string', pattern: '^[a-z0-9.-]{1,32}$' } })),
  pinAik: validator<{ aikPub: string; deviceList: DeviceList; platform: string; name: string; escrow?: { enc: string; ct: string } }>(
    obj(
      { aikPub: S.b64key32, deviceList: deviceListSchema, platform: { enum: ['windows', 'macos'] }, name: { type: 'string', minLength: 1, maxLength: 40 }, escrow: obj({ enc: S.b64key32, ct: SEALED_KEY }) },
      ['aikPub', 'deviceList', 'platform', 'name'],
    ),
  ),
  enroll: validator<{ deviceId: string; role: 'desktop' | 'mobile'; platform: string; name: string; Sx: string; Vx: string }>(
    obj({ deviceId: S.uuid4, role: { enum: ['desktop', 'mobile'] }, platform: { enum: ['windows', 'macos', 'ios', 'android'] }, name: { type: 'string', minLength: 1, maxLength: 40 }, Sx: S.b64key32, Vx: S.b64key32 }),
  ),
  deviceList: validator<{ deviceList: DeviceList }>(obj({ deviceList: deviceListSchema })),
  enrollMobile: validator<{ deviceId: string; role: 'mobile'; platform: 'ios' | 'android'; name: string; Sx: string; Vx: string; roomId: string }>(
    obj({ deviceId: S.uuid4, role: { const: 'mobile' }, platform: { enum: ['ios', 'android'] }, name: { type: 'string', minLength: 1, maxLength: 40 }, Sx: S.b64key32, Vx: S.b64key32, roomId: { type: 'string', pattern: '^[A-Za-z0-9_-]{22}$' } }),
  ),
  op: validator<{ op: AcctOp; aikSig: string }>(signedOpSchema),
  deviceToken: validator<{ cert: SignedCert; scopes?: Scope[]; model?: string }>(obj({ cert: signedCertSchema, scopes: { type: 'array', minItems: 1, maxItems: ALL_SCOPES.length, uniqueItems: true, items: { enum: [...ALL_SCOPES] } }, model: { type: 'string', minLength: 1, maxLength: 40 } }, ['cert'])),
  linkId: validator<{ id: string }>(obj({ id: S.uuid4 })),
  pcLinkHello: validator<{ hello: { v: 1; device_id: string; Sx: string; Vx: string; Hx: string; commit: string } }>(
    obj({ hello: obj({ v: { const: 1 }, device_id: S.uuid4, Sx: S.b64key32, Vx: S.b64key32, Hx: S.b64key32, commit: S.b64key32 }) }),
  ),
  pcLinkChallenge: validator<{ challenge: { v: 1; device_id: string; aik_pub: string; nonce: string } }>(obj({ challenge: obj({ v: { const: 1 }, device_id: S.uuid4, aik_pub: S.b64key32, nonce: S.b64key32 }) })),
  pcLinkReveal: validator<{ reveal: { v: 1; nonce: string } }>(obj({ reveal: obj({ v: { const: 1 }, nonce: S.b64key32 }) })),
  pcLinkGrant: validator<{ grant: { v: 1; cert: SignedCert; deviceList: DeviceList; enc: string; ct: string } }>(
    obj({ grant: obj({ v: { const: 1 }, cert: signedCertSchema, deviceList: deviceListSchema, enc: S.b64key32, ct: { type: 'string', pattern: '^[A-Za-z0-9+/]{64}$' } }) }),
  ),
  keyEscrowPut: validator<{ enc: string; ct: string }>(obj({ enc: S.b64key32, ct: SEALED_KEY })),
  keyEscrowReset: validator<{ deviceId: string; aikPub: string; deviceList: DeviceList; enc: string; ct: string }>(
    obj({ deviceId: S.uuid4, aikPub: S.b64key32, deviceList: deviceListSchema, enc: S.b64key32, ct: SEALED_KEY }),
  ),
  keyEscrowClaim: validator<{ deviceId: string; Hx: string }>(obj({ deviceId: S.uuid4, Hx: S.b64key32 })),
  deviceJoin: validator<{ deviceId: string; deviceList: DeviceList }>(obj({ deviceId: S.uuid4, deviceList: deviceListSchema })),
  recoveryPut: validator<{ blob: string }>(obj({ blob: { type: 'string', minLength: 44, maxLength: Math.ceil(RECOVERY.maxBytes / 3) * 4, pattern: '^[A-Za-z0-9+/]+={0,2}$' } })),
  unlockShare: validator<{ se: string }>(obj({ se: S.b64key32 })),
  unlockVerify: validator<{ unlockId: string; code: string; Tx: string }>(obj({ unlockId: S.token, code: { type: 'string', pattern: '^[0-9]{6}$' }, Tx: S.b64key32 })),
  issueLockId: validator<{ lockId: string }>(obj({ lockId: S.token })),
  shareRowId: validator<{ id: string }>(obj({ id: SHARE_ROW_ID })),
  shareRow: validator<{ kind: ShareKind; epoch: number; body: string; taskId?: string }>(
    obj(
      { kind: { enum: [...SHARE.kinds] }, epoch: { type: 'integer', minimum: 0, maximum: SHARE.maxEpoch }, body: { type: 'string', pattern: '^[A-Za-z0-9_-]+$', minLength: 64, maxLength: SHARE.maxBodyChars }, taskId: SHARE_ROW_ID },
      ['kind', 'epoch', 'body'],
    ),
  ),
  bindBiz: validator<{ bizHmac: string; rkOp?: { op: AcctOp; aikSig: string } }>(obj({ bizHmac: S.hex32, rkOp: signedOpSchema }, ['bizHmac'])),
} as const;

const PLATFORM_ROLE: Record<string, 'desktop' | 'mobile'> = { windows: 'desktop', macos: 'desktop', ios: 'mobile', android: 'mobile' };

export interface AccountAppOpts {
  svc: AccountService;
  verifier: TokenVerifier;
  publicOrigin: string;
  internal: InternalCheck;
  limits?: Limits;
  /** 문서함 계정 사본(ADR-064). 조각 저장소가 없으면 없고, 경로는 404다. */
  docs?: DocBox;
}

export function accountRouter(o: AccountAppOpts): Router {
  const { svc } = o;
  const r = new Router();
  const limits = o.limits ?? memoryLimits(svc.now);
  const ipSalt = limits.salt('ip');
  const emailSalt = limits.salt('email');
  const devSalt = limits.idSalt('dev');
  const idSalt = new DailySalt('aid', svc.now);
  const directory: DeviceDirectory = { get: (id) => svc.deviceRecord(id) };
  const deviceAuth = new DeviceAuth({ verifier: o.verifier, directory, publicOrigin: o.publicOrigin, now: svc.now });

  const limit = async (key: string, n: number, windowMs: number) => {
    const h = await limits.limiter.hit(key, n, windowMs);
    if (!h.ok) fail('policy.rate_limited', { retryAfterSec: h.retryAfterSec });
  };
  const ipKey = (ctx: Ctx) => ipSalt.hash(ctx.ip);
  const loggedIn = async (ctx: Ctx, out: { session: string; accountId: string }, method: AuthMethod, remember: boolean | undefined) => {
    ctx.logAid = idSalt.hash(out.accountId);
    const body: Record<string, unknown> = { session: out.session, expiresInSec: ACCOUNT.sessionTtlMs / 1000 };
    if (remember) {
      body.refreshToken = await svc.issueRefresh(out.accountId, method);
      body.refreshExpiresInSec = ACCOUNT.refreshTtlMs / 1000;
    }
    return json(200, body);
  };
  const session = async (ctx: Ctx): Promise<Session> => {
    const s = await svc.session(ctx.headers.authorization);
    ctx.logAid = idSalt.hash(s.accountId);
    return s;
  };
  const device = async (ctx: Ctx, scope: 'devlist' | 'slots' | 'acct_op') => {
    const c = await deviceAuth.check(ctx, scope, 'account.unauthorized', 'account.device_suspended');
    ctx.logAid = idSalt.hash(c.acc);
    return c;
  };
  const billingAuth = async (ctx: Ctx): Promise<BillingCaller> => {
    if (String(ctx.headers.authorization ?? '').startsWith('DPoP ')) {
      const c = await device(ctx, 'devlist');
      if (c.role !== 'desktop') fail('account.scope_denied');
      return { accountId: c.acc };
    }
    return session(ctx);
  };
  const sessionOrDevice = async (ctx: Ctx): Promise<string> => {
    const auth = String(ctx.headers.authorization ?? '');
    if (auth.startsWith('DPoP ')) return (await device(ctx, 'devlist')).acc;
    return (await session(ctx)).accountId;
  };
  const desktop = async (ctx: Ctx) => {
    const c = await device(ctx, 'devlist');
    if (c.role !== 'desktop') fail('account.scope_denied');
    return c;
  };
  const deviceMgmt = async (ctx: Ctx) => {
    const c = await deviceAuth.check(ctx, ['devlist', 'devices'], 'account.unauthorized', 'account.device_suspended');
    ctx.logAid = idSalt.hash(c.acc);
    return c;
  };

  r.add('POST', '/v1/auth/code', async (ctx) => {
    const b = V.codeStart(ctx.body);
    await limit(`code-ip:${await ipKey(ctx)}`, ACCOUNT.loginCodeSendsPerIpHour, MS.H);
    await limit(`code-email:${await emailSalt.hash(b.email.trim().toLowerCase())}`, ACCOUNT.loginCodeSendsPerEmailHour, MS.H);
    return json(200, await svc.startEmailCode(b.email));
  });
  r.add('POST', '/v1/auth/code/verify', async (ctx) => {
    const b = V.codeVerify(ctx.body);
    await limit(`auth-ip:${await ipKey(ctx)}`, ACCOUNT.authAttemptsPerIpHour, MS.H);
    const out = await svc.verifyEmailCode(b.loginId, b.code);
    return loggedIn(ctx, out, 'email_code', b.remember);
  });
  r.add('POST', '/v1/auth/passkey/options', async (ctx) => {
    await limit(`auth-ip:${await ipKey(ctx)}`, ACCOUNT.authAttemptsPerIpHour, MS.H);
    return json(200, await svc.passkeyLoginOptions());
  });
  r.add('POST', '/v1/auth/passkey/verify', async (ctx) => {
    const b = V.passkeyLogin(ctx.body);
    await limit(`auth-ip:${await ipKey(ctx)}`, ACCOUNT.authAttemptsPerIpHour, MS.H);
    const { remember, ...assertion } = b;
    const out = await svc.passkeyLogin(b.challenge, assertion);
    return loggedIn(ctx, out, 'passkey', remember);
  });
  r.add('POST', '/v1/auth/logout', async (ctx) => {
    await svc.logout(ctx.headers.authorization);
    return json(204, undefined);
  });
  r.add('POST', '/v1/auth/logout-all', async (ctx) => {
    await svc.logoutAll(await session(ctx));
    return json(204, undefined);
  });

  r.add('POST', '/v1/auth/refresh', async (ctx) => {
    const b = V.refresh(ctx.body);
    await limit(`refresh-ip:${await ipKey(ctx)}`, ACCOUNT.authAttemptsPerIpHour, MS.H);
    const out = await svc.refresh(b.refreshToken);
    ctx.logAid = idSalt.hash(out.accountId);
    return json(200, { session: out.session, expiresInSec: ACCOUNT.sessionTtlMs / 1000, refreshToken: out.refreshToken, refreshExpiresInSec: ACCOUNT.refreshTtlMs / 1000 });
  });
  r.add('POST', '/v1/auth/refresh/revoke', async (ctx) => {
    const b = V.refresh(ctx.body);
    await svc.revokeRefresh(b.refreshToken);
    return json(204, undefined);
  });

  r.add('POST', '/v1/oauth/authorize', async (ctx) => {
    const s = await session(ctx);
    const b = V.authorize(ctx.body);
    return json(200, await svc.authorize(s, { clientId: b.client_id, redirectUri: b.redirect_uri, codeChallenge: b.code_challenge, method: b.code_challenge_method, state: b.state }));
  });
  r.add('POST', '/v1/oauth/token', async (ctx) => {
    const b = V.token(ctx.body);
    await limit(`auth-ip:${await ipKey(ctx)}`, ACCOUNT.authAttemptsPerIpHour, MS.H);
    const out = await svc.exchangeCode({ code: b.code, verifier: b.code_verifier, redirectUri: b.redirect_uri, clientId: b.client_id });
    return loggedIn(ctx, out, out.authMethod, b.remember);
  });

  r.add('POST', '/v1/passkeys/options', async (ctx) => json(200, await svc.passkeyRegisterOptions(await session(ctx))));
  r.add('POST', '/v1/passkeys', async (ctx) => {
    const s = await session(ctx);
    const b = V.passkeyRegister(ctx.body);
    return json(201, await svc.passkeyRegister(s, b.challenge, b));
  });

  r.add('GET', '/v1/me', async (ctx) => json(200, await svc.me(await session(ctx))));
  r.add('POST', '/v1/consents', async (ctx) => {
    const s = await session(ctx);
    await svc.consent(s, V.consent(ctx.body).version);
    return json(204, undefined);
  });

  const sessionOrDesktop = async (ctx: Ctx): Promise<string> => {
    if (!String(ctx.headers.authorization ?? '').startsWith('DPoP ')) return (await session(ctx)).accountId;
    const c = await device(ctx, 'devlist');
    if (c.role !== 'desktop') fail('account.scope_denied');
    return c.acc;
  };
  r.add('GET', '/v1/account/deletion', async (ctx) => json(200, await svc.accountDeletion(await sessionOrDesktop(ctx))));
  r.add('POST', '/v1/account/delete-request', async (ctx) => json(202, await svc.requestAccountDelete(await sessionOrDesktop(ctx))));
  r.add('POST', '/v1/account/delete-cancel', async (ctx) => {
    await svc.cancelAccountDelete(await sessionOrDesktop(ctx));
    return json(204, undefined);
  });

  r.add('POST', '/v1/billing/checkout', async (ctx) => json(200, await svc.checkout(await billingAuth(ctx))));
  r.add('GET', '/v1/billing/subscription', async (ctx) => {
    const who = await billingAuth(ctx);
    return json(200, { subscription: await svc.subscription(who), entitlement: await svc.entitlementOf(who) });
  });
  r.add('GET', '/v1/billing/entitlement', async (ctx) => json(200, await svc.entitlementOf(await billingAuth(ctx))));
  r.add('POST', '/v1/billing/refund', async (ctx) => json(200, await svc.refundSubscription(await billingAuth(ctx))));
  r.add('POST', '/v1/billing/cancel', async (ctx) => {
    await svc.cancelSubscription(await billingAuth(ctx));
    return json(204, undefined);
  });
  const page = (r: { status: number; html: string }, nonce: string) => ({ status: r.status, raw: r.html, headers: pageHeaders(nonce) });
  r.add('GET', '/v1/billing/card', async (ctx) => {
    const nonce = randomToken(16);
    return page(await svc.billingCardPage(ctx.query.get('ref') ?? '', nonce), nonce);
  });
  r.add('GET', '/v1/billing/card/success', async (ctx) => {
    const nonce = randomToken(16);
    return page(await svc.billingCardSuccess(ctx.query.get('customerKey') ?? '', ctx.query.get('authKey') ?? '', nonce), nonce);
  });
  r.add('GET', '/v1/billing/card/fail', async (ctx) => {
    const nonce = randomToken(16);
    return page(svc.billingCardFail(ctx.query.get('code') ?? '', nonce), nonce);
  });
  r.add(
    'POST',
    '/v1/billing/webhook',
    async (ctx) => {
      await svc.paymentWebhook(ctx.rawBody, ctx.headers);
      return json(200, { ok: true });
    },
    { raw: true, maxBodyBytes: 16 * 1024 },
  );

  r.add('POST', '/v1/aik', async (ctx) => {
    const s = await session(ctx);
    const b = V.pinAik(ctx.body);
    return json(201, await svc.pinFirstDesktop(s, b));
  });
  const sessionOrMgmt = async (ctx: Ctx): Promise<string> =>
    String(ctx.headers.authorization ?? '').startsWith('DPoP ') ? (await deviceMgmt(ctx)).acc : (await session(ctx)).accountId;
  r.add('GET', '/v1/devices', async (ctx) => json(200, { devices: await svc.listDevices(await sessionOrMgmt(ctx)) }));
  r.add('POST', '/v1/devices/self/leave', async (ctx) => {
    const c = await deviceMgmt(ctx);
    await svc.leave({ accountId: c.acc, deviceId: c.dev });
    return json(204, undefined);
  });
  r.add('POST', '/v1/devices/:id/stop', async (ctx) => {
    const c = await deviceMgmt(ctx);
    await limit(`devstop:${await devSalt.hash(c.dev)}`, DEVICE.stopsPerDeviceDay, MS.D);
    return json(202, await svc.stopByDevice({ accountId: c.acc, deviceId: c.dev }, ctx.params.id!));
  });
  r.add('POST', '/v1/devices/enroll', async (ctx) => {
    if (String(ctx.headers.authorization ?? '').startsWith('DPoP ')) {
      const c = await device(ctx, 'devlist');
      if (c.role !== 'desktop') fail('account.scope_denied');
      const b = V.enrollMobile(ctx.body);
      const { created, ...out } = await svc.enrollByDesktop({ accountId: c.acc, deviceId: c.dev }, b);
      return json(created ? 201 : 200, created ? { holdUntil: out.holdUntil } : out);
    }
    const s = await session(ctx);
    const b = V.enroll(ctx.body);
    if (PLATFORM_ROLE[b.platform] !== b.role) fail('request.param_rejected');
    return json(201, await svc.enroll(s, b));
  });
  r.add('POST', '/v1/devices/:id/activate', async (ctx) => {
    await svc.activateAfterHold(await session(ctx), ctx.params.id!);
    return json(204, undefined);
  });
  r.add('POST', '/v1/devices/:id/suspend', async (ctx) => {
    await svc.suspend(await session(ctx), ctx.params.id!);
    return json(204, undefined);
  });
  r.add('POST', '/v1/devices/:id/delete-request', async (ctx) => json(202, await svc.requestDelete(await session(ctx), ctx.params.id!)));
  r.add('POST', '/v1/devices/:id/delete-cancel', async (ctx) => {
    await svc.cancelDelete(await session(ctx), ctx.params.id!);
    return json(204, undefined);
  });
  r.add('GET', '/v1/device-list', async (ctx) => json(200, await svc.deviceList(await sessionOrMgmt(ctx))));
  r.add('GET', '/v1/acct-claim', async (ctx) => {
    const c = await device(ctx, 'devlist');
    if (c.role !== 'desktop') fail('account.scope_denied');
    await limit(`acctclaim:${await devSalt.hash(c.dev)}`, DEVICE.acctClaimsPerHour, MS.H);
    return json(200, await svc.acctClaim({ accountId: c.acc, deviceId: c.dev }));
  });

  r.add('PUT', '/v1/device-list', async (ctx) => {
    const c = await device(ctx, 'devlist');
    const b = V.deviceList(ctx.body);
    return json(200, await svc.updateDeviceList({ accountId: c.acc, deviceId: c.dev }, b.deviceList));
  });
  r.add('POST', '/v1/devices/:id/reactivate', async (ctx) => {
    const c = await device(ctx, 'acct_op');
    await svc.reactivate({ accountId: c.acc, deviceId: c.dev }, ctx.params.id!, V.op(ctx.body));
    return json(204, undefined);
  });

  r.add('POST', '/v1/device-tokens', async (ctx) => {
    const b = V.deviceToken(ctx.body);
    await limit(`devtok-ip:${await ipKey(ctx)}`, DEVICE.deviceTokenAttemptsPerIpHour, MS.H);
    const dpop = ctx.headers.dpop;
    const out = await svc.issueDeviceToken(b.cert, Array.isArray(dpop) ? undefined : dpop, o.publicOrigin + ctx.path, async () => limit(`devtok:${await devSalt.hash(b.cert.cert.device_id)}`, DEVICE.deviceTokensPerHour, MS.H), b.scopes, b.model);
    return json(200, out);
  });

  r.add('POST', '/v1/slots', async (ctx) => json(201, await svc.createSlot((await device(ctx, 'slots')).acc)));
  r.add('GET', '/v1/slots', async (ctx) => json(200, { slots: await svc.listSlots(await sessionOrDevice(ctx)) }));
  r.add('PUT', '/v1/slots/:slot/biz', async (ctx) => {
    const c = await device(ctx, 'slots');
    const b = V.bindBiz(ctx.body);
    return json(200, await svc.bindBiz(c.acc, ctx.params.slot!, b.bizHmac, b.rkOp));
  });
  r.add('DELETE', '/v1/slots/:slot', async (ctx) => {
    await svc.deleteSlot((await device(ctx, 'slots')).acc, ctx.params.slot!);
    return json(204, undefined);
  });

  const accSalt = limits.idSalt('acc');
  const linkId = (ctx: Ctx) => V.linkId({ id: ctx.params.id }).id;
  const linkNew = async (ctx: Ctx) => {
    const s = await session(ctx);
    await limit(`pclink:s:${await accSalt.hash(s.accountId)}`, PC_LINK.callsPerHour, MS.H);
    return s;
  };
  const linkOld = async (ctx: Ctx) => {
    const c = await device(ctx, 'devlist');
    await limit(`pclink:d:${await devSalt.hash(c.dev)}`, PC_LINK.callsPerHour, MS.H);
    return { accountId: c.acc, deviceId: c.dev };
  };
  const dpopAuth = (ctx: Ctx) => String(ctx.headers.authorization ?? '').startsWith('DPoP ');
  r.add('GET', '/v1/pc-links', async (ctx) => json(200, { links: await svc.pcLinks((await linkOld(ctx)).accountId) }));
  r.add('PUT', '/v1/pc-links/:id', async (ctx) => {
    const s = await linkNew(ctx);
    await limit(`pclink:h:${await accSalt.hash(s.accountId)}`, PC_LINK.hellosPerAccountHour, MS.H);
    await svc.putPcLinkHello(s, linkId(ctx), V.pcLinkHello(ctx.body).hello);
    return json(204, undefined);
  });
  r.add('GET', '/v1/pc-links/:id', async (ctx) => json(200, await svc.pcLinkForNew(await linkNew(ctx), linkId(ctx))));
  r.add('POST', '/v1/pc-links/:id/reveal', async (ctx) => {
    await svc.putPcLinkReveal(await linkNew(ctx), linkId(ctx), V.pcLinkReveal(ctx.body).reveal);
    return json(204, undefined);
  });
  r.add('POST', '/v1/pc-links/:id/challenge', async (ctx) => {
    await svc.putPcLinkChallenge(await linkOld(ctx), linkId(ctx), V.pcLinkChallenge(ctx.body).challenge);
    return json(204, undefined);
  });
  r.add('POST', '/v1/pc-links/:id/grant', async (ctx) => {
    await svc.putPcLinkGrant(await linkOld(ctx), linkId(ctx), V.pcLinkGrant(ctx.body).grant);
    return json(204, undefined);
  });
  r.add('DELETE', '/v1/pc-links/:id', async (ctx) => {
    const old = dpopAuth(ctx);
    await svc.deletePcLink(old ? (await linkOld(ctx)).accountId : (await linkNew(ctx)).accountId, linkId(ctx), old);
    return json(204, undefined);
  });

  const escrowOld = async (ctx: Ctx) => {
    const c = await device(ctx, 'devlist');
    await limit(`escrow:d:${await devSalt.hash(c.dev)}`, KEY_ESCROW.callsPerHour, MS.H);
    return { accountId: c.acc, deviceId: c.dev };
  };
  const escrowNew = async (ctx: Ctx) => {
    const s = await session(ctx);
    await limit(`escrow:s:${await accSalt.hash(s.accountId)}`, KEY_ESCROW.callsPerHour, MS.H);
    return s;
  };
  r.add('GET', '/v1/key-escrow', async (ctx) => json(200, await svc.keyEscrowState((await escrowOld(ctx)).accountId)));
  r.add('PUT', '/v1/key-escrow', async (ctx) => {
    await svc.putKeyEscrow(await escrowOld(ctx), V.keyEscrowPut(ctx.body));
    return json(204, undefined);
  });
  r.add('POST', '/v1/key-escrow/claim', async (ctx) => {
    const s = await escrowNew(ctx);
    const b = V.keyEscrowClaim(ctx.body);
    await limit(`escrow:c:${await accSalt.hash(s.accountId)}`, KEY_ESCROW.claimsPerAccountDay, MS.D);
    return json(200, await svc.claimKeyEscrow(s, b.deviceId, b.Hx));
  });
  r.add('GET', '/v1/key-escrow/pub', async (ctx) => {
    await escrowNew(ctx);
    return json(200, svc.keyEscrowPub());
  });
  r.add('POST', '/v1/key-escrow/reset', async (ctx) => {
    const s = await escrowNew(ctx);
    const b = V.keyEscrowReset(ctx.body);
    await limit(`escrow:c:${await accSalt.hash(s.accountId)}`, KEY_ESCROW.claimsPerAccountDay, MS.D);
    return json(200, await svc.resetByKeyEscrow(s, b.deviceId, b));
  });
  r.add('POST', '/v1/key-escrow/off', async (ctx) => {
    const c = await desktop(ctx);
    await svc.keyEscrowOff({ accountId: c.acc, deviceId: c.dev }, V.op(ctx.body));
    return json(204, undefined);
  });

  // 새 PC를 기기 목록에 넣기(ADR-061 결정 4). /v1/key-escrow/join은 옮겨 가기 기한까지 옛 판 PC가 부르는 같은 처리기다(결정 10).
  const join = async (ctx: Ctx) => {
    const s = await escrowNew(ctx);
    const b = V.deviceJoin(ctx.body);
    return json(200, await svc.joinDevice(s, b.deviceId, b.deviceList));
  };
  r.add('POST', '/v1/devices/join', join);
  r.add('POST', '/v1/key-escrow/join', join);

  // 복구 코드로 잠근 계정 열쇠(ADR-061 결정 8). 쓰는 것은 쓰던 PC, 읽는 것은 계정 세션(새 PC)이나 쓰던 PC
  r.add('PUT', '/v1/recovery', async (ctx) => {
    const c = await desktop(ctx);
    await limit(`recovery:w:${await devSalt.hash(c.dev)}`, RECOVERY.writesPerDeviceDay, MS.D);
    await svc.putRecovery({ accountId: c.acc, deviceId: c.dev }, V.recoveryPut(ctx.body).blob);
    return json(204, undefined);
  });
  r.add('GET', '/v1/recovery', async (ctx) => {
    const acc = await sessionOrDesktop(ctx);
    await limit(`recovery:r:${await accSalt.hash(acc)}`, RECOVERY.readsPerAccountDay, MS.D);
    return json(200, await svc.recovery(acc));
  });
  r.add('DELETE', '/v1/recovery', async (ctx) => {
    const c = await desktop(ctx);
    await svc.deleteRecovery({ accountId: c.acc, deviceId: c.dev });
    return json(204, undefined);
  });

  // 이메일로 PC 잠금 풀기(ADR-061 결정 7). 모두 그 PC의 기기 키로만 부른다. 계정 세션으로는 부를 수 없다(새 PC는 이 길로 열쇠를 받지 못한다)
  r.add('PUT', '/v1/unlock-email/share', async (ctx) => {
    const c = await desktop(ctx);
    await limit(`unlock:p:${await devSalt.hash(c.dev)}`, UNLOCK_EMAIL.sharePutsPerDeviceHour, MS.H);
    await svc.putUnlockShare({ accountId: c.acc, deviceId: c.dev }, V.unlockShare(ctx.body).se);
    return json(204, undefined);
  });
  r.add('DELETE', '/v1/unlock-email/share', async (ctx) => {
    const c = await desktop(ctx);
    await svc.deleteUnlockShare({ accountId: c.acc, deviceId: c.dev });
    return json(204, undefined);
  });
  r.add('POST', '/v1/unlock-email/code', async (ctx) => {
    const c = await desktop(ctx);
    await limit(`unlock:s:${await devSalt.hash(c.dev)}`, UNLOCK_EMAIL.sendsPerDeviceDay, MS.D);
    return json(200, await svc.startUnlockEmail({ accountId: c.acc, deviceId: c.dev }));
  });
  r.add('POST', '/v1/unlock-email/verify', async (ctx) => {
    const c = await desktop(ctx);
    const b = V.unlockVerify(ctx.body);
    await limit(`unlock:v:${await devSalt.hash(c.dev)}`, UNLOCK_EMAIL.verifiesPerDeviceHour, MS.H);
    return json(200, await svc.finishUnlockEmail({ accountId: c.acc, deviceId: c.dev }, b.unlockId, b.code, b.Tx));
  });

  const issueLock = async (ctx: Ctx) => {
    const c = await device(ctx, 'devlist');
    await limit(`issuelock:${await devSalt.hash(c.dev)}`, ISSUE_LOCK.callsPerDeviceHour, MS.H);
    return { accountId: c.acc, deviceId: c.dev };
  };
  r.add('GET', '/v1/issue-lock', async (ctx) => {
    const c = await issueLock(ctx);
    const l = await svc.issueLock(c.accountId);
    return json(200, { ...l, mine: l.deviceId === c.deviceId });
  });
  r.add('POST', '/v1/issue-lock/acquire', async (ctx) => json(200, await svc.acquireIssueLock(await issueLock(ctx))));
  r.add('POST', '/v1/issue-lock/renew', async (ctx) => {
    const c = await issueLock(ctx);
    return json(200, await svc.renewIssueLock(c, V.issueLockId(ctx.body).lockId));
  });
  r.add('POST', '/v1/issue-lock/release', async (ctx) => {
    const c = await issueLock(ctx);
    await svc.releaseIssueLock(c, V.issueLockId(ctx.body).lockId);
    return json(204, undefined);
  });

  r.add(
    'POST',
    '/v1/invoice-mail',
    async (ctx) => {
      const c = await device(ctx, 'devlist');
      if (c.role !== 'desktop') fail('account.scope_denied');
      const b = V.invoiceMail(ctx.body);
      const pdf = Buffer.from(b.pdf, 'base64');
      if (pdf.length > INVOICE_MAIL.pdfMaxBytes || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') fail('request.param_rejected');
      await limit(`invmail:d:${await devSalt.hash(c.dev)}`, INVOICE_MAIL.perDeviceHour, MS.H);
      await limit(`invmail:a:${await devSalt.hash(c.acc)}`, INVOICE_MAIL.perAccountDay, MS.D);
      await svc.sendInvoiceMail({ to: b.to, supplierEmail: b.supplierEmail ?? null, supplierName: b.supplierName, buyerName: b.buyerName, approvalNo: b.approvalNo, issueDate: b.issueDate, total: b.total, pdf });
      return json(202, { sent: true });
    },
    { maxBodyBytes: INVOICE_MAIL.bodyMaxBytes },
  );

  const share = async (ctx: Ctx, kind: 'r' | 'w') => {
    const c = await deviceAuth.check(ctx, 'share', 'account.unauthorized', 'account.device_suspended');
    ctx.logAid = idSalt.hash(c.acc);
    await limit(`share:${kind}:${await devSalt.hash(c.dev)}`, kind === 'w' ? SHARE.writesPerDeviceHour : SHARE.readsPerDeviceHour, MS.H);
    return { accountId: c.acc, deviceId: c.dev, role: c.role };
  };
  const shareDesktop = async (ctx: Ctx) => {
    const c = await share(ctx, 'w');
    if (c.role !== 'desktop') fail('account.scope_denied');
    return c;
  };
  const shareId = (ctx: Ctx) => V.shareRowId({ id: ctx.params.id }).id;
  r.add('PUT', '/v1/share/rows/:id', async (ctx) => {
    const c = await share(ctx, 'w');
    return json(200, await svc.putShareRow(c, { rowId: shareId(ctx), ...V.shareRow(ctx.body) }));
  });
  const shareRowsFrom = async (ctx: Ctx, raw: string) => {
    const c = await share(ctx, 'r');
    if ([...ctx.query.keys()].length || !/^(0|[1-9][0-9]{0,15})$/.test(raw)) fail('request.param_rejected');
    return json(200, await svc.shareRows(c.accountId, Number(raw)));
  };
  r.add('GET', '/v1/share/rows', (ctx) => shareRowsFrom(ctx, '0'));
  r.add('GET', '/v1/share/rows/after/:seq', (ctx) => shareRowsFrom(ctx, ctx.params.seq ?? ''));
  r.add('GET', '/v1/share/tasks', async (ctx) => json(200, { tasks: await svc.shareTasks((await share(ctx, 'r')).accountId) }));
  r.add('POST', '/v1/share/tasks/:id/claim', async (ctx) => json(200, await svc.claimShareTask(await shareDesktop(ctx), shareId(ctx))));
  r.add('POST', '/v1/share/tasks/:id/release', async (ctx) => {
    await svc.releaseShareTask(await shareDesktop(ctx), shareId(ctx));
    return json(204, undefined);
  });
  r.add('POST', '/v1/share/tasks/:id/cancel', async (ctx) => {
    await svc.cancelShareTask(await share(ctx, 'w'), shareId(ctx));
    return json(204, undefined);
  });

  if (o.docs) {
    addDocRoutes(r, {
      docs: o.docs,
      auth: async (ctx, kind) => {
        const c = await deviceAuth.check(ctx, 'share', 'account.unauthorized', 'account.device_suspended');
        ctx.logAid = idSalt.hash(c.acc);
        await limit(`docs:${kind}:${await devSalt.hash(c.dev)}`, kind === 'w' ? DOCS.writesPerDeviceHour : DOCS.readsPerDeviceHour, MS.H);
        return { accountId: c.acc, deviceId: c.dev, role: c.role };
      },
    });
  }

  r.add('GET', '/internal/v1/devices/:id', async (ctx) => {
    await o.internal.check(ctx);
    const rec = await svc.deviceRecord(ctx.params.id!);
    return rec ? json(200, rec) : json(404, { error: 'account.device_not_found' });
  });
  r.add(
    'POST',
    '/internal/v1/devices/:id/auto-suspend',
    async (ctx) => {
      await o.internal.check(ctx);
      return json(200, { suspended: await svc.autoSuspend(ctx.params.id!) });
    },
    { raw: true },
  );
  r.add('GET', '/healthz', () => json(200, { ok: true }));
  return r;
}
