# R16. 홈택스 자동화가 닿는 주소 목록

탐색 도메인 제한을 정하려고 모은 목록이다. 코드는 바꾸지 않았다. 기준은 main `042aec2`(2026-11-26)이고, 실측 메모(`/mnt/project-files/hometax-ref/*.md`)로 보탰다. 가짜 홈택스(`poc/tests/hometax-fake*.ts`, `127.0.0.1`)는 넣지 않았다.

## 1. 한 줄 요약

- 자동화가 닿는 곳은 모두 `hometax.go.kr`과 그 하위 도메인이다. 하위 도메인은 `www`, `teet`, `tecr`, `teht`, `sesw` 다섯 개다.
- 다른 eTLD+1은 없다. 공동인증서 모듈(MagicLine, `/MagicLine4XML/`)과 간편인증(`/oacx/`)도 `hometax.go.kr` 경로에 있다.
- 지금 꾸러미 12개의 `manifest.domains`는 모두 `["hometax.go.kr", "*.hometax.go.kr"]`이고, 금고의 `PORTAL_ETLD1`은 `["hometax.go.kr"]`이다. 좁힌다면 하위 도메인 다섯 개를 이름으로 적는 것이 다음 단계다(4절).

## 2. 이동하는 주소(goto)

꾸러미가 `goto` 스텝으로 바로 여는 주소다. 모두 `https://hometax.go.kr/websquare/websquare.html?w2xPath=/ui/pp/index_pp.xml` 뒤에 메뉴 번호(`tmIdx`, `tm2lIdx`, `tm3lIdx`)만 붙는다.

| 꾸러미(판) | 여는 주소의 메뉴 번호 | 화면 |
|---|---|---|
| hometax.invoice.issue (2.3.9) | 번호 없음, `46 / 4601000000 / 4601010100` | 첫 화면, 건별 발급 |
| hometax.invoice.amend (1.1.0) | 번호 없음, 그 뒤 메뉴 클릭 `#menuAtag_4601010400` | 첫 화면 → 수정발급 |
| hometax.invoice.bulk (1.0.0) | 번호 없음, 그 뒤 메뉴 클릭 `#menuAtag_4601010500` | 첫 화면 → 일괄발급 |
| hometax.invoice.lookup (1.3.0) | `46 / 4609000000 / 4609050100` | 목록조회(발급 확정 조회) |
| hometax.invoice.buyer_lookup (1.0.0) | `46 / 4609000000 / 4609050100` | 목록조회 |
| hometax.invoice.email_status (1.3.0) | `46 / 4601000000 / 4601030100` | 메일 발송 조회 |
| hometax.report.sync (1.0.0) | 번호 없음, 그 뒤 금고가 메뉴 클릭(3절 끝) | 첫 화면 → 월 리포트 화면 다섯 |
| hometax.cert.biz_registration (1.1.0) | 번호 없음, `43 / 4315010000 / 4315010800`, `43 / 4315000000 / 4315050000` | 사업자등록증명 신청, 발급 결과 |
| hometax.cert.financial_statements (1.1.0) | 번호 없음, `… / 4315011800`, 발급 결과 | 표준재무제표증명 |
| hometax.cert.taxpayment (1.1.0) | 번호 없음, `… / 4315010300`, 발급 결과 | 납세증명 |
| hometax.cert.vat_tax_base (1.1.0) | 번호 없음, `… / 4315010500`, 발급 결과 | 부가세 과세표준증명 |
| hometax.cert.issued_list (1.0.1) | `43 / 4315000000 / 4315050000` | 발급 결과 |

꾸러미 밖에서 여는 주소:

- 엔진 `browser.open`(`poc/packages/engine/src/entry.ts`)은 `https://www.hometax.go.kr/`을 연다. `www`가 붙은 주소는 여기 하나다.
- 점검 신호(`poc/packages/engine/src/signals.ts`): 점검 중에는 모든 주소가 `https://(www.)hometax.go.kr/info_page.html`로 307 된다. 이동 대상이 아니라 알아보는 주소다.

## 3. 화면이 보내는 요청(XHR, 폼)

셀렉터 파일의 `knownEndpoints`와 `commitEndpoints`, 금고 코드, 실측 메모에서 모았다. 화면 틀은 `hometax.go.kr`에서 뜨고, 자료 요청은 업무별 하위 도메인으로 간다.

| 호스트 | 경로 | 누가 | 무엇 |
|---|---|---|---|
| teet.hometax.go.kr | `/wqAction.do` (POST) | issue, amend, bulk, lookup, buyer_lookup, email_status, report.sync | 전자세금계산서 화면 요청 전부. 커밋은 `actionId` `ATEETBAA002C04`, `C05`, `C08`(건별, 수정), `ATEETBAA004C13`, `C15`, `C16`(일괄) |
| teet.hometax.go.kr | `/permission.do` (POST) | 같은 일곱 꾸러미 | 화면 권한 확인 |
| teet.hometax.go.kr | `/websquare/excelToGrid2.wq` (POST) | bulk | 일괄발급 엑셀 변환 |
| tecr.hometax.go.kr | `/wqAction.do`, `/permission.do` (POST) | report.sync | 현금영수증 매출(`ATECRCBA001R03`), 매입(`ATECRCBA001R02`), 사업용 카드(`ATECRCCA001R06`) |
| teht.hometax.go.kr | `/wqAction.do`, `/permission.do` (POST) | report.sync | 신용카드 매출자료(`ATESFAAA014R02`) |
| sesw.hometax.go.kr | `/serp/clipreport.do`, `/serp/ClipReport4/ClipAndMarkAny.jsp` (POST, 팝업 창) | 금고 `pdf/save.ts`(민원증명 원본 PDF, ADR-062) | ClipReport4 뷰어 창과 인쇄 요청. 금고는 경로만 본다(`isOriginalViewer`) |
| hometax.go.kr | `/MagicLine4XML/ML4Web/…` (iframe `#dscert`) | 공동인증서 로그인, 서명 | 인증서 고르기, 비밀번호 창. 비밀 넣기 허용 origin(`SECRET_ORIGINS`)은 `hometax.go.kr` |
| hometax.go.kr | `/oacx/…` (iframe) | 간편인증(`engine/src/run/simple-auth.ts` `OACX_URL`) | 간편인증 사업자 고르기와 요청 |
| hometax.go.kr | `/js/comm/netfunnel/netfunnel.js` | 홈택스 대기열 | 대기 팝업. 이동 대상이 아니라 신호 |

월 리포트 화면 다섯(`poc/packages/vault/src/report/screens.ts`)은 메뉴 클릭으로 들어간다. 매출, 매입 세금계산서는 `menuAtag_4609050100`(teet), 현금영수증 매출 `menuAtag_4606010100`(tecr), 매입 `menuAtag_4605010100`(tecr), 신용카드 매출자료 `menuAtag_4607010000`(teht), 사업용 카드 `menuAtag_4608020100`(tecr)이다.

## 4. 지금 있는 막이와 비어 있는 곳

| 막이 | 어디 | 무엇을 막나 |
|---|---|---|
| `manifest.domains` + `urlProblem`(V-06) | `engine/src/core/validate.ts`, `core/loader.ts` `navigationUrlProblem` | 꾸러미 `goto` 주소와 엔드포인트 호스트가 domains 밖이면 꾸러미를 싣지 않거나 이동하지 않는다. `*.x`는 하위 도메인만 받는다(`hostAllowed`) |
| 커밋 가드 | `engine/src/commitguard/endpoints.ts`, `cdp.ts` | domains 밖 요청은 `outside`로 보고 커밋으로 세지 않는다 |
| 조회 팝업 | `engine/src/driver/lookup.ts`, `lookup-ir.ts` | 팝업이 domains 안인지(`portal` 판정) |
| 금고 중계 | `vault/src/relay/policy.ts` | `Page.navigate`는 `PORTAL_ETLD1` 안 주소만. 밖이면 `origin_not_allowed` |
| 비밀 넣기 | `vault/src/secret/ops.ts` | 비밀번호는 `SECRET_ORIGINS` 프레임에만 |
| 앱 바깥 링크 | `apps/desktop/src/external-links.ts` | `hometax.go.kr`(MagicLine 설치 파일), `tax.laf-co.com`(약관)만 브라우저로 연다. 자동화 아님 |

비어 있는 곳(다음 작업 후보, 추론):

- 모든 막이가 `*.hometax.go.kr` 전체를 받는다. 쓰는 하위 도메인은 `www`, `teet`, `tecr`, `teht`, `sesw` 다섯뿐이라 이름으로 좁힐 수 있다. 꾸러미 manifest를 바꾸면 다시 서명하고 게시해야 하니, 엔진이나 금고 쪽 내장 목록으로 좁히는 길이 가볍다.
- 클릭이 일으킨 이동(메뉴 클릭, 팝업, 홈택스 스크립트가 바꾸는 `location`)은 `goto`처럼 미리 재지 않는다. 금고 중계는 CDP `Page.navigate`만 보고, 페이지가 스스로 가는 이동은 보지 않는다. 제한을 넣는다면 `framenavigated`(엔진 `driver/wire.ts`, `actuator.ts`가 이미 듣는다)에서 위 다섯 호스트 밖이면 멈추고 로그를 남기는 자리다.
- 경로까지 좁히려면 2절과 3절 경로(`/websquare/websquare.html`, `/wqAction.do`, `/permission.do`, `/websquare/excelToGrid2.wq`, `/serp/…`, `/MagicLine4XML/…`, `/oacx/…`, `/info_page.html`)가 출발점이다. 로그인 화면과 인증 창 안에서 홈택스가 부르는 정적 파일 경로는 실측하지 않았다.

## 5. 어떻게 모았나

```
grep -rhoE "https?://[A-Za-z0-9.-]+" poc/packages/engine/playbooks poc/packages/engine/src poc/packages/vault/src poc/scripts/playbooks
grep -rhoE "[a-z0-9-]+(\.[a-z0-9-]+)*\.(go\.kr|co\.kr|com|kr|net)" (같은 곳 + poc/apps/desktop/src)
python3: playbooks/*/playbook.json의 goto url, selectors.json의 host/pathPattern, manifest.json의 domains
```

실화면으로 다시 재지는 않았다. 3절의 `sesw`, `tecr`, `teht` 요청은 11-24, 11-25 맥북 실측 메모(`cert-pdf-probe.md`, `report-probe.md`)에 적힌 것이다.
