# ADR-062. 민원증명 PDF는 홈택스 원본 서류를 받는다(처리결과 조회 [출력] → 원본 뷰어)

> 상태: 제안(2026-11-24). 대표 요청(2026-11-24): "민원서류의 경우도 pdf가 해당 민원서류 pdf여야 함". 실측: 2026-11-24 맥북 Chrome, 개인사업자 로그인, 이미 발급된 사업자등록증명으로(새 신청 없음).
> 고치는 결정: 민원증명 플레이북 4종의 `s32 save_pdf strategy:print`(신청 완료 화면 인쇄). 잇는 결정: [ADR-025](ADR-025-poc3-real-account-safety-baseline.md)(금고가 PDF를 저장하고 엔진에는 fileId만), [ADR-060](ADR-060-invoice-pdf-own-render-and-mail.md)(세금계산서 PDF).

## 맥락

- 지금 민원증명 PDF는 신청을 마친 홈택스 화면을 인쇄한 것이다. 증명서가 아니다.
- 홈택스는 「민원신청 처리결과 조회」의 행마다 수령방법 단추([출력] 또는 [열람])를 둔다. [출력] → 「국세증명 위·변조 방지를 위한 경고 안내문」 「예」 → ClipReport4 뷰어 창(`https://sesw.hometax.go.kr/serp/clipreport.do`, 이름 `reportPopup_N`)이 뜬다. 뷰어의 인쇄는 MarkAny 에이전트를 부르는데, 같은 요청(`POST /serp/ClipReport4/ClipAndMarkAny.jsp`, `ClipID=R08`, 리포트 키, `print=print`)을 뷰어 창 안에서 보내면 응답 본문이 원본 PDF다(%PDF-1.4, 발급번호, 2D 바코드, 세무서장 직인, 글자 층 있음, 암호 없음).
- 「예」를 누르면 발급수량을 쓴다. 같은 건을 다시 누르면 「이미 발급이 완료되었습니다.」가 뜨고 뷰어가 열리지 않는다(실측). 한 번에 받아야 한다.
- [열람]은 「열람용」 워터마크가 박힌 법적 효력 없는 화면이라 쓰지 않는다. 신청 수령방법은 지금처럼 「인터넷발급(프린터출력)」이다.
- 처리결과 조회 목록은 `ul#mf_txppWframe_gen_cvaInf > li`(최근 신청이 맨 위), 행마다 접수번호 `a[id$="_tbx_rcatNo"]` 하나와 `input[id$="_btn_cvaDcumGranMthdNm"]` 하나다(실측 7행).
- 처리결과 조회 주소의 상위 메뉴는 `4315000000`이다(메뉴 클릭이 여는 주소). 조회 패키지의 `tm2lIdx=4315050000`은 틀린 주소였고 실측에서 로그아웃을 일으켰다.

## 결정

1. **발급 확인(verify committed) 뒤 구간을 바꾼다(민원증명 4종 공통).** `s31` 처리결과 조회로 이동 → `s31a` 목록 대기 → `s31b` `pick`: 접수번호(`$vars.issueNo`, verify가 묶은 값)와 같은 행의 [출력] → `s31c`·`s31d` 경고 「예」 → `s32 save_pdf strategy:original`. 재시도하지 않는다(발급수량). 실패하면 지금처럼 "발급은 완료되었어요. 증명서 PDF는 받지 못했어요"로 끝나고 다시 발급하지 않는다.
2. **`pick`에 `rows.button`을 더한다(IR rev v1.3.9).** 행을 고르는 대신 by와 이름 칸이 같은 행 안의 단추 하나를 누른다. 행이 하나여도 by가 맞아야 한다. 다른 행의 [출력]을 누르면 그 건의 발급수량을 쓰기 때문이다.
3. **`save_pdf strategy:original`은 금고 `pdf.original {runId, targetId}`다.** 금고가 그 탭이 연 노출된 팝업 중 경로가 `/serp/clipreport.do`인 창을 30초 안에 찾고, 금고에 고정된 스크립트로 그 창에서 원본 PDF를 받는다(리포트 키와 쪽수는 뷰어의 `m_reportHashMap`에서). 패키지와 엔진은 스크립트를 바꿀 수 없다. PDF 검사(머리, `%%EOF`, 15MB) 뒤 staging에 두고 엔진에는 fileId만 준다. 받은 뒤 뷰어 창을 닫는다.
4. **조회 패키지 `hometax.cert.issued_list` 1.0.1**: 첫 주소를 `tm2lIdx=4315000000&tm3lIdx=4315050000`으로.

## 아직 확인하지 않은 것(실화면 예행 몫)

- 뷰어의 `m_reportHashMap` 값 모양(리포트 키 이름, 쪽수 함수). 스크립트는 `uid`, `getTotalPage` 등 후보를 차례로 본다. 쪽수를 못 읽으면 1쪽만 받을 수 있어(표준재무제표증명은 여러 쪽) 금고 로그에 `pages: unknown`을 남긴다.
- 실측 때 뷰어를 연 [출력]은 이미 1/1이었다. 새 발급 한 건으로 예행해야 한다.

## 영향

- 패키지 재게시: `hometax.cert.biz_registration`, `vat_tax_base`, `financial_statements`, `taxpayment` 1.1.0, `hometax.cert.issued_list` 1.0.1. 서명과 게시는 대표(Touch ID).
- 앱: 금고 `pdf.original`이 든 앱이 먼저 배포돼야 한다(옛 앱은 strategy original을 V-23a로 거부한다).
