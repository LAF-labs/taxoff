import { randomBytes } from 'node:crypto';
import { AIK_PURPOSES, fromB64, softNoiseStatic, softSigner, VD_PURPOSES, verifyDeviceList, x25519Public, type DesktopKeys } from '@sax/remote';
import type { AccountClient } from '../dist/remote-ports.js';

export function fakeAccount() {
  const calls: string[] = [];
  let pinned: { aikPub: string; deviceId: string } | null = null;
  const fail = (code: string) => Object.assign(new Error(code), { code });
  const client: AccountClient = {
    startEmailCode: async () => (calls.push('code'), { loginId: 'L1', expiresInSec: 600 }),
    verifyEmailCode: async (_l, code) => {
      calls.push('verify');
      if (code !== '123456') throw fail('account.code_invalid');
      return { session: 'sxs1.fake', expiresInSec: 3600 };
    },
    logout: async () => void calls.push('logout'),
    refresh: async () => {
      throw fail('account.unauthorized');
    },
    revokeRefresh: async () => {},
    logoutAll: async () => {
      throw fail('net.not_in_e2e');
    },
    deviceList: async () => (calls.push('list'), { aikPub: null, deviceList: null }),
    pinFirstDesktop: async (_s, b) => {
      calls.push('aik');
      const l = verifyDeviceList(b.deviceList, fromB64(b.aikPub));
      if (!l.ok || l.devices.length !== 1) throw fail('account.aik_signature_invalid');
      pinned = { aikPub: b.aikPub, deviceId: l.devices[0]!.deviceId };
      return { deviceId: pinned.deviceId };
    },
    deviceToken: async () => {
      throw fail('net.not_in_e2e');
    },
    acctClaim: async () => {
      throw fail('net.not_in_e2e');
    },
    enrollPhone: async () => {},
    billing: async () => ({ entitlement: { state: 'trial' as const, until: null }, subscription: null }),
    billingCheckout: async () => ({ checkoutUrl: 'https://tax.laf-co.com/v1/billing/card?ref=cus_aaaaaaaaaaaaaaaaaaaaaaaa' }),
    billingCancel: async () => {},
    billingRefund: async () => ({ amountKrw: 0 }),
    putDeviceList: async () => {},
    devices: async () => [],
    leaveDevice: async () => {},
    devicesBySession: async () => [],
    deviceListByDevice: async () => ({ aikPub: null, deviceList: null }),
    enrollDesktop: async () => {},
    pcLinkHello: async () => {},
    pcLinkAnswer: async () => ({ challenge: null, grant: null }),
    pcLinkReveal: async () => {},
    pcLinkCancel: async () => {},
    pcLinks: async () => [],
    pcLinkChallenge: async () => {},
    pcLinkGrant: async () => {},
    pcLinkDrop: async () => {},
    keyEscrowState: async () => {
      throw Object.assign(new Error('escrow'), { code: 'request.not_found' });
    },
    putKeyEscrow: async () => {},
    claimKeyEscrow: async () => {
      throw Object.assign(new Error('escrow'), { code: 'request.not_found' });
    },
    keyEscrowOff: async () => {
      throw fail('net.not_in_e2e');
    },
    putRecovery: async () => {
      throw fail('net.not_in_e2e');
    },
    recovery: async () => {
      throw fail('net.not_in_e2e');
    },
    deleteRecovery: async () => {
      throw fail('net.not_in_e2e');
    },
    putUnlockShare: async () => {
      throw fail('net.not_in_e2e');
    },
    deleteUnlockShare: async () => {
      throw fail('net.not_in_e2e');
    },
    startUnlockEmail: async () => {
      throw fail('net.not_in_e2e');
    },
    finishUnlockEmail: async () => {
      throw fail('net.not_in_e2e');
    },
    joinDevice: async () => {},
    keyEscrowPub: async () => {
      throw Object.assign(new Error('escrow'), { code: 'request.not_found' });
    },
    resetByKeyEscrow: async () => {},
    issueLock: async () => ({ held: false, deviceId: null, expiresAt: null, mine: false }),
    acquireIssueLock: async () => ({ lockId: 'fake-lock-0000000000000000', expiresAt: Date.now() + 90_000 }),
    renewIssueLock: async () => ({ expiresAt: Date.now() + 90_000 }),
    releaseIssueLock: async () => {},
    wakePhone: async () => ({ sent: false }),
    sendInvoiceMail: async () => undefined,
    putShareRow: async () => ({ seq: 1 }),
    shareRows: async () => ({ rows: [], head: 0, epoch: 0, more: false }),
    shareTasks: async () => [],
    claimShareTask: async () => ({ claimExpiresAt: Date.now() + 900_000 }),
    releaseShareTask: async () => {},
    cancelShareTask: async () => {},
    accountDeletion: async () => ({ deleteAfter: null }),
    requestAccountDelete: async () => ({ deleteAfter: Date.now() + 7 * 86_400_000 }),
    cancelAccountDelete: async () => {},
  };
  return { client, calls, pinned: () => pinned };
}

export function softKeys(): DesktopKeys {
  const k = () => new Uint8Array(randomBytes(32));
  const kv = k();
  return { noise: softNoiseStatic(k()), vd: softSigner(k(), VD_PURPOSES), aik: softSigner(k(), AIK_PURPOSES), kvPublic: () => x25519Public(kv) };
}
