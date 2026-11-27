import writeXlsxFile from 'write-excel-file/node';

/**
 * 여러 건 발급 양식(대표 결정 2026-11-24 "양식 없이 가능하되 제공도. 잘못 신고하면 가산세라 정확하게 입력되게"). 앱은 어떤 장부든 읽지만,
 * 처음 쓰는 사장님에게는 앱 파서(@sax/docparse invoice-batch)가 머리글 사전으로 바로 읽는 칸 이름만 담은 양식을 준다.
 * 첫 시트는 머리글 한 줄뿐이다. 보기 줄은 넣지 않는다(지우지 않고 올리면 보기까지 발급되기 때문). 적는 법은 둘째 시트에 문장으로만 쓴다
 * (표 꼴로 쓰면 파서가 그 시트를 발급 표로 볼 수 있다).
 */
export const TEMPLATE_NAME = '택스오프 세금계산서 여러 건 양식.xlsx';

export const TEMPLATE_COLUMNS = [
  { head: '거래처 상호', width: 24 },
  { head: '사업자등록번호', width: 16 },
  { head: '작성일자', width: 12 },
  { head: '품목', width: 24 },
  { head: '공급가액', width: 14 },
  { head: '세액', width: 12 },
  { head: '받는 이메일', width: 28 },
  { head: '비고', width: 20 },
] as const;

const GUIDE = [
  '이 양식은 첫 시트 「발급할 계산서」에 한 줄에 한 건씩 적어요. 첫 줄의 칸 이름은 바꾸지 마세요.',
  '거래처 상호: 사업자등록증에 적힌 상호를 적어요.',
  '사업자등록번호: 숫자 10자리를 적어요. 줄표는 있어도 되고 없어도 돼요. 앱이 국세청에 휴업, 폐업을 확인하고, 번호가 틀리거나 폐업한 곳은 발급 전에 알려요.',
  '작성일자: 공급한 날을 2026-11-24처럼 적어요. 다음 달 10일이 지나면 늦게 발급한 것이 돼 가산세가 붙을 수 있어요.',
  '품목: 무엇을 공급했는지 적어요.',
  '공급가액: 부가세를 뺀 금액을 숫자로 적어요.',
  '세액: 비워 두면 공급가액의 10%로 계산해요. 영세율이나 다른 세액이면 직접 적어요.',
  '받는 이메일: 계산서를 받을 거래처 메일이에요. 비우면 거래처 목록의 메일로 보내요.',
  '파일을 대화창에 끌어다 놓으면 앱이 모든 줄을 확인한 뒤 목록으로 보여 줘요. 승인하기 전에는 아무것도 발급하지 않아요.',
];

export async function bulkTemplate(): Promise<Buffer> {
  const head = TEMPLATE_COLUMNS.map((c) => ({ value: c.head, fontWeight: 'bold' as const, backgroundColor: '#F2F2F2' }));
  return writeXlsxFile(
    [
      { sheet: '발급할 계산서', data: [head], columns: TEMPLATE_COLUMNS.map((c) => ({ width: c.width })), stickyRowsCount: 1 },
      { sheet: '적는 법', data: GUIDE.map((t) => [{ value: t, wrap: true }]), columns: [{ width: 100 }] },
    ] as never,
    { fontFamily: 'Malgun Gothic', fontSize: 11 },
  ).toBuffer();
}
