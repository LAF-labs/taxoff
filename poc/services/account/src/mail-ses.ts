import { createHash, createHmac } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import type { InvoiceMail, MailSender, NoticeKind } from './adapters.ts';

/** 허용 리전. Phase 1은 서울만(D09 §1, 국내 처리 원칙) */
export const SES_REGIONS = ['ap-northeast-2'] as const;
export type SesRegion = (typeof SES_REGIONS)[number];
export const SES_PATH = '/v2/email/outbound-emails';
const sesOrigin = (r: string) => `https://email.${r}.amazonaws.com`;

/** 송신 대상이 허용 목록(허용 리전의 SES v2 SendEmail 경로 하나)인가. 쿼리·조각·다른 경로·다른 호스트는 거부 */
export function sesEndpointAllowed(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (SES_REGIONS as readonly string[]).some((r) => u.origin === sesOrigin(r)) && u.pathname === SES_PATH && !u.search && !u.hash && url === u.origin + SES_PATH;
}

/** 메일 실패. code는 이벤트 이름에 쓰는 고정 값이고, 응답 본문(주소를 되풀이할 수 있다)은 담지 않는다 */
export class MailError extends Error {
  readonly code: 'mail.throttled' | 'mail.unavailable' | 'mail.auth_failed' | 'mail.config' | 'mail.rejected' | 'mail.not_allowed';
  readonly retryable: boolean;
  constructor(code: MailError['code'], retryable: boolean) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}

const sha256Hex = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s, 'utf8').digest();

export interface SigV4Input {
  method: string;
  path: string;
  query?: string;
  headers: Record<string, string>;
  payloadSha256: string;
  amzDate: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** SigV4 Authorization 헤더 값. 헤더 값은 앞뒤 공백을 빼고 연속 공백을 하나로 접는다 */
export function sigv4(i: SigV4Input): string {
  const h = new Map(Object.entries(i.headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const names = [...h.keys()].sort();
  const canonHeaders = names.map((n) => `${n}:${h.get(n)}\n`).join('');
  const signed = names.join(';');
  const canonical = [i.method, i.path, i.query ?? '', canonHeaders, signed, i.payloadSha256].join('\n');
  const day = i.amzDate.slice(0, 8);
  const scope = `${day}/${i.region}/${i.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', i.amzDate, scope, sha256Hex(canonical)].join('\n');
  const kDate = hmac(`AWS4${i.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, i.region), i.service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign, 'utf8').digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
}

export const amzDate = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export type MailKind = 'code' | 'unlock_code' | NoticeKind;

const NOTICE_TEXT: Record<NoticeKind, { subject: string; body: string }> = {
  device_enrolled: { subject: '새 기기가 등록됐어요', body: '계정에 새 기기가 등록됐어요. 직접 한 일이 아니면 PC 앱에서 그 기기를 긴급 정지하세요.' },
  device_suspended: { subject: '기기를 긴급 정지했어요', body: '계정의 기기 하나를 긴급 정지했어요. 그 기기는 더 이상 연결되지 않아요.' },
  device_auto_suspended: { subject: '기기를 자동으로 정지했어요', body: '비정상적인 사용이 감지돼 기기 하나를 자동으로 정지했어요. PC 앱에서 기기 목록을 확인하세요.' },
  device_delete_pending: { subject: '기기 삭제를 요청했어요', body: '기기 삭제를 요청했어요. 7일 뒤에 삭제돼요. 직접 한 일이 아니면 PC 앱에서 취소하세요.' },
  account_delete_pending: { subject: '탈퇴를 요청했어요', body: '탈퇴를 요청했어요. 구독은 해지돼 다음 결제가 없고, 7일 뒤에 계정 정보가 삭제돼요. 직접 한 일이 아니면 그 전에 PC 앱 설정에서 탈퇴를 취소하세요. 이 Mac에 있는 자료는 앱을 지우기 전까지 남아요.' },
  device_revoked: { subject: '기기가 계정에서 빠졌어요', body: '기기 하나가 계정에서 폐기됐어요. 그 기기는 더 이상 연결되지 않아요.' },
  aik_pinned: { subject: 'PC가 계정에 연결됐어요', body: '이 계정에 PC 신원 키가 등록됐어요. 직접 한 일이 아니면 고객 지원에 알려 주세요.' },
  passkey_added: { subject: '새 패스키가 등록됐어요', body: '계정에 새 패스키가 등록됐어요. 직접 한 일이 아니면 PC 앱에서 확인하세요.' },
  email_unlocked: { subject: '이메일로 PC 잠금을 풀었어요', body: '이메일 숫자로 PC 잠금을 풀었어요. 직접 한 일이 아니면 연결된 폰이나 다른 PC의 설정에서 그 PC를 끊으세요.' },
  recovery_set: { subject: '복구 코드를 만들었어요', body: '계정 복구 코드를 새로 만들었어요. 옛 복구 코드는 더 쓸 수 없어요. 직접 한 일이 아니면 PC 앱 설정에서 확인하세요.' },
  sessions_revoked: { subject: '모든 기기에서 로그아웃했어요', body: '자동 로그인 정보가 다른 곳에서 다시 쓰여 모든 기기에서 로그아웃했어요. 다시 로그인하세요.' },
  subscription_canceled: { subject: '구독 해지를 접수했어요', body: '구독을 해지했어요. 다음 결제는 없고, 이미 낸 기간이 끝날 때까지 쓸 수 있어요.' },
  subscription_refunded: { subject: '청약철회 환불을 접수했어요', body: '구독을 철회하고 환불을 접수했어요. 카드사에 따라 3~7영업일 안에 결제가 취소돼요.' },
  payment_failed: { subject: '구독 결제가 실패했어요', body: '이번 달 구독 결제가 승인되지 않았어요. 내일 다시 시도해요. 카드를 바꾸려면 PC 앱의 구독 화면에서 다시 등록하세요.' },
  trial_converting: { subject: '무료 체험이 곧 끝나요', body: '무료 체험이 7일 안에 끝나요. 체험이 끝나는 날 등록한 카드로 월 19,900원(부가세 포함)이 자동 결제되고, 그 뒤 매월 같은 날 결제돼요. 원하지 않으면 그 전에 PC 앱의 구독 화면에서 해지하세요. 해지하면 결제되지 않아요.' },
  pc_move_asked: { subject: '새 PC가 기록을 가져가요', body: '계정에 붙은 새 PC가 쓰던 PC의 기록(통장 내역, 영수증, 서류)을 가져가겠다고 했어요. 쓰던 PC가 켜져 있으면 바로 보내요. 직접 한 일이 아니면 지금 연결된 폰이나 쓰던 PC의 설정에서 그 PC를 끊으세요.' },
  subscription_ended: { subject: '구독이 끝났어요', body: '결제가 세 번 승인되지 않아 구독이 끝났어요. PC 앱의 구독 화면에서 다시 구독할 수 있어요.' },
};

const PREFIX = '[소버린 AX] ';
const FOOTER = '\n\n이 메일은 보내기 전용이에요. 링크를 넣지 않아요. 메일에 있는 주소로 로그인하라는 요청은 따르지 마세요.';

/** 종류별 제목·본문. 값은 코드(6자리)뿐이다 */
export function mailContent(kind: MailKind, code?: string): { subject: string; text: string } {
  if (kind === 'code' || kind === 'unlock_code') {
    if (!code || !/^\d{6}$/.test(code)) throw new MailError('mail.rejected', false);
    const what = kind === 'code' ? '로그인' : 'PC 잠금 풀기';
    return { subject: `${PREFIX}${what} 코드`, text: `${what} 코드: ${code}\n10분 동안 쓸 수 있어요. 요청하지 않았다면 이 메일을 무시하세요.${FOOTER}` };
  }
  const t = NOTICE_TEXT[kind];
  if (!t) throw new MailError('mail.rejected', false);
  return { subject: PREFIX + t.subject, text: t.body + FOOTER };
}

const oneLine = (v: string, max: number) => [...v].map((c) => (c.charCodeAt(0) < 0x20 || c === '\u007f' || c === '\u2028' || c === '\u2029' ? ' ' : c)).join('').replace(/\s+/g, ' ').trim().slice(0, max);
const won = (n: number) => `${Math.round(n).toLocaleString('ko-KR')}원`;
const approvalText = (v: string) => (/^\d{24}$/.test(v.replace(/-/g, '')) ? v.replace(/-/g, '').replace(/^(\d{8})(\d{8})(\d{8})$/, '$1-$2-$3') : v);

/** 세금계산서 메일의 제목, 본문, 첨부 이름. 값은 한 줄로 접고 길이를 자른다(헤더·본문 주입 방어). */
/**
 * 첨부 이름은 PC 보관 이름(@sax/db docFileName의 tax_invoice)과 같은 규칙이다. 계정 서비스는 @sax/db를 쓰지 않아 같은 규칙을 여기 둔다.
 * 거래처명은 파일 이름에 못 쓰는 글자, 빈칸, 제어 문자, 앞 점을 빼고 40자까지. 남는 것이 없으면 거래처 칸을 뺀다.
 */
export function invoiceAttachmentName(buyerName: string, issueDate: string): string {
  const who = [...buyerName].filter((c) => c.charCodeAt(0) >= 0x20).join('').replace(/[\\/:*?"<>|\s]+/g, '').replace(/^\.+/, '').slice(0, 40);
  return `전자세금계산서${who ? `_${who}` : ''}_${issueDate.replace(/-/g, '')}.pdf`;
}

export function invoiceMailContent(m: InvoiceMail): { subject: string; text: string; fileName: string } {
  const supplier = oneLine(m.supplierName, 70);
  const buyer = oneLine(m.buyerName, 70);
  const no = approvalText(m.approvalNo);
  const contact = m.supplierEmail ? `${supplier}(${m.supplierEmail})` : supplier;
  const lines = [
    buyer ? `${buyer} 담당자님께` : '담당자님께',
    '',
    '안녕하십니까.',
    `${supplier}에서 발행한 전자세금계산서를 첨부하여 보내 드립니다.`,
    '',
    `작성일자: ${m.issueDate}`,
    `합계금액: ${won(m.total)}`,
    `승인번호: ${no}`,
    '',
    '이 세금계산서는 국세청 홈택스에서 승인번호로 조회하실 수 있습니다.',
    `이 메일은 발신 전용이라 회신하실 수 없습니다. 문의 사항은 ${contact}에 연락해 주시기 바랍니다.`,
    '',
    '감사합니다.',
    '',
    `이 메일은 택스오프가 ${supplier}의 요청으로 대신 발송했습니다.`,
  ];
  return { subject: `[${supplier}] 전자세금계산서 발행 안내 (${m.issueDate})`, text: lines.join('\n'), fileName: invoiceAttachmentName(m.buyerName, m.issueDate) };
}

const b64 = (s: string | Uint8Array) => Buffer.from(s).toString('base64');
const wrap = (s: string) => s.replace(/.{1,76}/g, '$&\r\n');
const word = (s: string) => `=?UTF-8?B?${b64(s)}?=`;

/** SES Raw로 보낼 MIME(multipart/mixed: 본문 + PDF 첨부). */
export function invoiceMime(from: string, m: InvoiceMail, boundary = `sax-${randomBytes(12).toString('hex')}`): string {
  const c = invoiceMailContent(m);
  const head = [
    `From: ${word('택스오프')} <${from}>`,
    `To: <${m.to}>`,
    `Subject: ${word(c.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(b64(c.text)),
    `--${boundary}`,
    `Content-Type: application/pdf; name="${word(c.fileName)}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${word(c.fileName)}"; filename*=UTF-8''${encodeURIComponent(c.fileName)}`,
    '',
    wrap(b64(m.pdf)),
    `--${boundary}--`,
    '',
  ];
  return [...head, '', ...parts].join('\r\n');
}

export interface SesOptions {
  region: SesRegion;
  from: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  onEvent?: (name: string) => void;
}

const ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;

function classify(status: number, errorType: string): MailError {
  const t = errorType.split(':')[0]!.trim();
  if (status === 429 || t === 'TooManyRequestsException' || t === 'LimitExceededException') return new MailError('mail.throttled', true);
  if (status >= 500) return new MailError('mail.unavailable', true);
  if (status === 401 || status === 403) return new MailError('mail.auth_failed', false);
  if (['AccountSuspendedException', 'SendingPausedException', 'MailFromDomainNotVerifiedException', 'NotFoundException'].includes(t)) return new MailError('mail.config', false);
  return new MailError('mail.rejected', false);
}

export class SesMailSender implements MailSender {
  readonly #o: Required<Omit<SesOptions, 'onEvent'>> & { onEvent: (n: string) => void };
  readonly #endpoint: string;

  constructor(o: SesOptions) {
    if (!(SES_REGIONS as readonly string[]).includes(o.region)) throw new Error('config_SES_REGION');
    if (!ADDRESS.test(o.from)) throw new Error('config_SES_FROM_ADDRESS');
    if (!/^[A-Z0-9]{16,128}$/.test(o.accessKeyId)) throw new Error('config_SES_ACCESS_KEY_ID');
    if (!/^[A-Za-z0-9/+=]{20,128}$/.test(o.secretAccessKey)) throw new Error('config_SES_SECRET_ACCESS_KEY');
    this.#o = { ...o, fetchFn: o.fetchFn ?? fetch, now: o.now ?? Date.now, timeoutMs: o.timeoutMs ?? 10_000, onEvent: o.onEvent ?? (() => undefined) };
    this.#endpoint = sesOrigin(o.region) + SES_PATH;
  }

  static fromEnv(env: NodeJS.ProcessEnv, extra: Pick<SesOptions, 'fetchFn' | 'now' | 'onEvent'> = {}): SesMailSender {
    const need = (n: string) => env[n] || (() => { throw new Error(`config_${n}`); })();
    return new SesMailSender({ region: 'ap-northeast-2', from: need('SES_FROM_ADDRESS'), accessKeyId: need('SES_ACCESS_KEY_ID'), secretAccessKey: need('SES_SECRET_ACCESS_KEY'), ...extra });
  }

  toJSON(): unknown {
    return { provider: 'ses', region: this.#o.region };
  }

  async sendLoginCode(to: string, code: string): Promise<void> {
    await this.send(to, mailContent('code', code));
  }

  async sendUnlockCode(to: string, code: string): Promise<void> {
    await this.send(to, mailContent('unlock_code', code));
  }

  async sendNotice(to: string, kind: NoticeKind): Promise<void> {
    await this.send(to, mailContent(kind));
  }

  async sendInvoice(m: InvoiceMail): Promise<void> {
    if (!ADDRESS.test(m.to) || (m.supplierEmail !== null && !ADDRESS.test(m.supplierEmail))) throw new MailError('mail.rejected', false);
    await this.post(
      JSON.stringify({ FromEmailAddress: this.#o.from, Destination: { ToAddresses: [m.to] }, Content: { Raw: { Data: b64(invoiceMime(this.#o.from, m)) } } }),
      'account.mail_invoice',
    );
  }

  private async send(to: string, c: { subject: string; text: string }): Promise<void> {
    if (!ADDRESS.test(to)) throw new MailError('mail.rejected', false);
    await this.post(
      JSON.stringify({
        FromEmailAddress: this.#o.from,
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: c.subject, Charset: 'UTF-8' }, Body: { Text: { Data: c.text, Charset: 'UTF-8' } } } },
      }),
      'account.mail_ses',
    );
  }

  private async post(body: string, ev: string): Promise<void> {
    if (!sesEndpointAllowed(this.#endpoint)) throw new MailError('mail.not_allowed', false);
    const host = new URL(this.#endpoint).host;
    const date = amzDate(this.#o.now());
    const payloadSha256 = sha256Hex(body);
    const headers: Record<string, string> = { 'content-type': 'application/json', host, 'x-amz-content-sha256': payloadSha256, 'x-amz-date': date };
    const authorization = sigv4({ method: 'POST', path: SES_PATH, headers, payloadSha256, amzDate: date, region: this.#o.region, service: 'ses', accessKeyId: this.#o.accessKeyId, secretAccessKey: this.#o.secretAccessKey });
    const sent = Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'host'));
    let res: Response;
    try {
      res = await this.#o.fetchFn(this.#endpoint, { method: 'POST', headers: { ...sent, authorization }, body, redirect: 'error', signal: AbortSignal.timeout(this.#o.timeoutMs) });
    } catch {
      this.#o.onEvent(`${ev}.unavailable`);
      throw new MailError('mail.unavailable', true);
    }
    const text = await res.text().catch(() => '');
    if (res.ok) {
      let id: unknown;
      try {
        id = (JSON.parse(text) as { MessageId?: unknown }).MessageId;
      } catch {
        id = undefined;
      }
      this.#o.onEvent(typeof id === 'string' && id ? `${ev}.sent` : `${ev}.sent_no_id`);
      return;
    }
    const err = classify(res.status, res.headers.get('x-amzn-errortype') ?? '');
    this.#o.onEvent(`${ev}.${err.code.slice('mail.'.length)}`);
    throw err;
  }
}
