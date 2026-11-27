import type { DeviceListJson, DesktopKeys, DocRecordWire, DeviceToken, DpopSigner, MailboxTokens, PcLinkChallenge, PcLinkGrant, PcLinkHello, PcLinkReveal, RelayQueue, ShareKind, ShareRowWire, SignedAcctClaim, SignedCert, WebSocketLike } from '@sax/remote';

export type DeviceAuth = (htm: 'GET' | 'POST' | 'PUT' | 'DELETE', htu: string) => Promise<Record<string, string>>;

export interface AccountLogin {
  session: string;
  expiresInSec: number;
  refreshToken?: string;
  refreshExpiresInSec?: number;
}

export interface BillingView {
  entitlement: { state: 'trial' | 'paid' | 'none'; until: number | null };
  subscription: { status: 'pending' | 'active' | 'past_due' | 'canceled'; renewAt: number | null; amountKrw: number; refund: { refundableUntil: number; amountKrw: number } | null } | null;
}

/** 거래처에 보내는 세금계산서 PDF 메일(대표 결정 2026-11-24, services/account/API.md). pdf는 PDF 바이트. */
export interface InvoiceMailRequest {
  to: string;
  supplierEmail: string | null;
  supplierName: string;
  buyerName: string;
  approvalNo: string;
  issueDate: string;
  total: number;
  pdf: Uint8Array;
}

export interface AccountClient {
  startEmailCode(email: string): Promise<{ loginId: string; expiresInSec: number }>;
  verifyEmailCode(loginId: string, code: string, remember?: boolean): Promise<AccountLogin>;
  refresh(refreshToken: string): Promise<Required<AccountLogin>>;
  revokeRefresh(refreshToken: string): Promise<void>;
  logoutAll(session: string): Promise<void>;
  logout(session: string): Promise<void>;
  deviceList(session: string): Promise<{ aikPub: string | null; deviceList: DeviceListJson | null }>;
  pinFirstDesktop(session: string, b: { aikPub: string; deviceList: DeviceListJson; platform: 'windows' | 'macos'; name: string; escrow?: { enc: string; ct: string } }): Promise<{ deviceId: string }>;
  deviceToken(cert: SignedCert, dpop: DpopSigner, scopes?: readonly string[], model?: string): Promise<DeviceToken>;
  billing(auth: DeviceAuth): Promise<BillingView>;
  billingCheckout(auth: DeviceAuth): Promise<{ checkoutUrl: string }>;
  billingCancel(auth: DeviceAuth): Promise<void>;
  billingRefund(auth: DeviceAuth): Promise<{ amountKrw: number }>;
  acctClaim(auth: DeviceAuth): Promise<SignedAcctClaim>;
  enrollPhone(auth: DeviceAuth, b: { deviceId: string; role: 'mobile'; platform: 'ios' | 'android'; name: string; Sx: string; Vx: string; roomId: string }): Promise<void>;
  putDeviceList(auth: DeviceAuth, list: DeviceListJson): Promise<void>;
  deviceListByDevice(auth: DeviceAuth): Promise<{ aikPub: string | null; deviceList: DeviceListJson | null }>;
  devices(auth: DeviceAuth): Promise<ServerDevice[]>;
  leaveDevice(auth: DeviceAuth): Promise<void>;
  devicesBySession(session: string): Promise<ServerDevice[]>;
  enrollDesktop(session: string, b: { deviceId: string; platform: 'windows' | 'macos'; name: string; Sx: string; Vx: string }): Promise<void>;
  pcLinkHello(session: string, deviceId: string, hello: PcLinkHello): Promise<void>;
  pcLinkAnswer(session: string, deviceId: string): Promise<{ challenge: unknown; grant: unknown }>;
  pcLinkReveal(session: string, deviceId: string, reveal: PcLinkReveal): Promise<void>;
  pcLinkCancel(session: string, deviceId: string): Promise<void>;
  pcLinks(auth: DeviceAuth): Promise<PcLinkRequest[]>;
  pcLinkChallenge(auth: DeviceAuth, deviceId: string, challenge: PcLinkChallenge): Promise<void>;
  pcLinkGrant(auth: DeviceAuth, deviceId: string, grant: PcLinkGrant): Promise<void>;
  pcLinkDrop(auth: DeviceAuth, deviceId: string): Promise<void>;
  keyEscrowState(auth: DeviceAuth): Promise<{ pub: string; stored: boolean }>;
  putKeyEscrow(auth: DeviceAuth, sealed: { enc: string; ct: string }): Promise<void>;
  claimKeyEscrow(session: string, b: { deviceId: string; Hx: string }): Promise<{ aikPub: string; enc: string; ct: string }>;
  /** 새 PC가 자기를 더한 AIK 서명 기기 목록을 올린다(ADR-061 결정 4) */
  joinDevice(session: string, deviceId: string, list: DeviceListJson): Promise<void>;
  /** 맡긴 열쇠 지우기(ADR-061 결정 10). op는 AIK로 서명한 계정 작업 escrow.off(target 'key_escrow') */
  keyEscrowOff(auth: DeviceAuth, op: { op: { op: 'escrow.off'; account_id: string; target: 'key_escrow'; ts: number }; aikSig: string }): Promise<void>;
  /** 복구 코드로 잠근 계정 열쇠 RKr(ADR-061 결정 8). blob은 금고가 만든 불투명한 base64(200바이트 이하) */
  putRecovery(auth: DeviceAuth, blob: string): Promise<void>;
  recovery(who: string | DeviceAuth): Promise<{ aikPub: string; blob: string; setAt: number }>;
  deleteRecovery(auth: DeviceAuth): Promise<void>;
  /** 이메일로 PC 잠금 풀기(ADR-061 결정 7). se는 금고가 만든 32바이트 조각(base64) */
  putUnlockShare(auth: DeviceAuth, se: string): Promise<void>;
  deleteUnlockShare(auth: DeviceAuth): Promise<void>;
  startUnlockEmail(auth: DeviceAuth): Promise<{ unlockId: string; expiresInSec: number }>;
  /** Tx는 금고의 한 번용 X25519 공개키. 돌아온 {enc, ct}는 HPKE(Tx, Se), info 'SAX-unlock-email-seal-v1' */
  finishUnlockEmail(auth: DeviceAuth, x: { unlockId: string; code: string; Tx: string }): Promise<{ enc: string; ct: string }>;
  keyEscrowPub(session: string): Promise<{ pub: string }>;
  resetByKeyEscrow(session: string, b: { deviceId: string; aikPub: string; deviceList: DeviceListJson; enc: string; ct: string }): Promise<void>;
  issueLock(auth: DeviceAuth): Promise<{ held: boolean; deviceId: string | null; expiresAt: number | null; mine: boolean }>;
  acquireIssueLock(auth: DeviceAuth): Promise<{ lockId: string; expiresAt: number }>;
  renewIssueLock(auth: DeviceAuth, lockId: string): Promise<{ expiresAt: number }>;
  releaseIssueLock(auth: DeviceAuth, lockId: string): Promise<void>;
  wakePhone(auth: DeviceAuth, deviceId: string, kind: 'approve' | 'update' | 'unlock'): Promise<{ sent: boolean }>;
  sendInvoiceMail(auth: DeviceAuth, m: InvoiceMailRequest): Promise<void>;
  putShareRow(auth: DeviceAuth, row: ShareRowWire & { taskId?: string }): Promise<{ seq: number }>;
  shareRows(auth: DeviceAuth, after: number): Promise<SharePage>;
  shareTasks(auth: DeviceAuth): Promise<ShareTaskState[]>;
  claimShareTask(auth: DeviceAuth, taskId: string): Promise<{ claimExpiresAt: number }>;
  releaseShareTask(auth: DeviceAuth, taskId: string): Promise<void>;
  cancelShareTask(auth: DeviceAuth, taskId: string): Promise<void>;
  accountDeletion(auth: DeviceAuth): Promise<{ deleteAfter: number | null }>;
  requestAccountDelete(auth: DeviceAuth): Promise<{ deleteAfter: number }>;
  cancelAccountDelete(auth: DeviceAuth): Promise<void>;
}

export interface ServerDevice {
  deviceId: string;
  role: 'desktop' | 'mobile';
  platform: 'windows' | 'macos' | 'ios' | 'android';
  name: string;
  state: 'pending' | 'active' | 'suspended' | 'revoked';
  registeredAt: number;
  Sx: string;
  Vx: string;
  deleteAfter: number | null;
  lastSeenAt: number | null;
}

export interface ShareServerRow extends ShareRowWire {
  seq: number;
  deviceId: string;
  at: number;
}
export interface SharePage {
  rows: ShareServerRow[];
  head: number;
  epoch: number;
  more: boolean;
}
export interface ShareTaskState {
  taskId: string;
  state: 'open' | 'claimed' | 'done' | 'cancelled' | 'expired';
  createdBy: string;
  claimedBy: string | null;
  claimExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}
export type { ShareKind };

export interface ShareVault {
  key(epoch: number): Promise<{ key: Uint8Array; signPub: Uint8Array }>;
  sign(msg: Uint8Array): Promise<Uint8Array>;
}

export interface PcLinkRequest {
  deviceId: string;
  name: string;
  platform: 'windows' | 'macos';
  createdAt: number;
  hello: unknown;
  challengedBy: string | null;
  reveal: unknown;
}

export interface PcLinkVault {
  key(): Promise<Uint8Array>;
  sealRk(recipient: Uint8Array, info: Uint8Array, aad: Uint8Array): Promise<{ enc: Uint8Array; ct: Uint8Array }>;
  importRk(g: { enc: Uint8Array; ct: Uint8Array; info: Uint8Array; aad: Uint8Array; aikPub: Uint8Array }): Promise<Uint8Array>;
}

export interface RelayHttpClient {
  createRoom(auth: DeviceAuth, roomId: Uint8Array): Promise<{ expiresAt: number }>;
  registerMailbox(auth: DeviceAuth, mbxId: Uint8Array, tokRead: Uint8Array, tokWrite: Uint8Array, peer?: string): Promise<void>;
  deleteMailbox(auth: DeviceAuth, mbxId: Uint8Array, tokWrite: Uint8Array, peer?: string): Promise<void>;
}

/** 문서함 계정 사본 한 건(계정 서비스 GET /v1/docs, ADR-064). record는 서버가 열 수 없는 기록 암호문이고, 지운 문서는 null이다. */
export interface DocServerEntry {
  docId: string;
  seq: number;
  state: 'ready' | 'deleted';
  rev: number;
  epoch: number;
  deviceId: string;
  chunks: number;
  record: string | null;
}
export interface DocsPage {
  docs: DocServerEntry[];
  head: number;
  more: boolean;
}
/** 문서함 계정 사본 경로(ADR-064). 올리기는 start → putChunk(전부) → putRecord 순서다. */
export interface DocsClient {
  start(auth: DeviceAuth, docId: string, size: { chunks: number; blobBytes: number }): Promise<void>;
  putChunk(auth: DeviceAuth, docId: string, i: number, data: Uint8Array): Promise<void>;
  putRecord(auth: DeviceAuth, wire: DocRecordWire): Promise<{ seq: number }>;
  list(auth: DeviceAuth, after: number): Promise<DocsPage>;
  getChunk(auth: DeviceAuth, docId: string, i: number): Promise<Uint8Array>;
  remove(auth: DeviceAuth, docId: string): Promise<void>;
}

export interface CloudPorts {
  account: AccountClient;
  relay: RelayHttpClient;
  /** 문서함 계정 사본(ADR-064). 시험용 가짜 포트에는 없을 수 있다. */
  docs?: DocsClient;
  relayHost: string;
  accountOrigin?: string;
  insecureLocal: boolean;
  openSocket(url: string, headers?: Record<string, string>): WebSocketLike;
  mailboxQueue?(mbxId: Uint8Array, tok: MailboxTokens, auth: DeviceAuth): RelayQueue;
}

export type VaultKeysFactory = (control: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<DesktopKeys>;
