export function normalizeBizNo(input: string): string {
  return input.replace(/\D/g, '');
}

export function isValidBizNo(input: string): boolean {
  const d = normalizeBizNo(input);
  if (!/^\d{10}$/.test(d)) return false;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * w[i]!;
  sum += Math.floor((Number(d[8]) * 5) / 10);
  return (10 - (sum % 10)) % 10 === Number(d[9]);
}

export function formatBizNo(input: string): string {
  const d = normalizeBizNo(input);
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : d;
}

/** 테스트용 합성 사업자번호(체크섬 유효, D13 §2). */
export function syntheticBizNo(seed: number): string {
  const base = String(100000000 + ((seed * 7919) % 899999999)).slice(0, 9);
  for (let c = 0; c <= 9; c++) if (isValidBizNo(base + c)) return base + c;
  throw new Error('unreachable');
}

/**
 * 사업자등록번호 가운데 두 자리(개인·법인 구분 코드)로 본 사업자 갈래. 01~79 개인 과세, 90~99 개인 면세,
 * 81·86·87·88 영리법인 본점, 85 영리법인 지점, 82 비영리법인, 84 외국법인. 그 밖(80, 83, 89)은 other다.
 */
export function bizNoKind(bizNo: string | null | undefined): 'individual' | 'exempt' | 'corporate' | 'other' | null {
  const d = (bizNo ?? '').replace(/\D/g, '');
  if (d.length !== 10) return null;
  const mid = Number(d.slice(3, 5));
  if (mid >= 1 && mid <= 79) return 'individual';
  if (mid >= 90) return 'exempt';
  return [81, 82, 84, 85, 86, 87, 88].includes(mid) ? 'corporate' : 'other';
}
