# ADR-069. 월 리포트의 홈택스 조회 화면은 금고 고정 스크립트가 읽는다

> 상태: 제안(2026-11-25). 대표 요청(2026-11-24): "모든 데이터는 자동업데이트가 기본이야", (2026-11-25) "할 수 있는 거 이어서 쭉 해".
> 실측: 2026-11-25 맥북 Chrome, 개인사업자 로그인, 조회와 화면 읽기만(`/mnt/project-files/hometax-ref/report-probe.md`, `list-probe.md`, 값은 가림).
> 잇는 결정: ADR-068 결정 6(홈택스 자동 받기, 받기 계획 `syncPlan`, 넣기 `bank.hometaxSync`, 실행 근거 `unlock`. tex #542), [ADR-063](ADR-063-bulk-upload-by-vault.md)(금고 고정 스크립트로 표 읽기), [ADR-026](ADR-026-human-secret-device-bound-session-vault.md)(금고 경계).

## 맥락

- 받을 화면은 다섯이다(세금계산서 목록조회는 매출과 매입 둘로 쓴다). 로그인 세션 하나로 모두 조회되고 추가 인증이 없다. 값은 엑셀 없이 WebSquare 표 API(`$p.getComponentById(..).getRowCount/getCellData`)로 다 읽힌다.
- 화면마다 고르는 기간이 다르다. 세금계산서는 날짜 범위 3개월, 현금영수증 매출과 매입과 사업용 카드는 달 하나, 카드 매출자료는 분기다. select는 컴포넌트 setValue로 바뀌지 않고 DOM selectedIndex와 change 이벤트로만 바뀐다.
- [조회]를 JS로 바로 누르면 검증 실패 시 네이티브 alert가 탭을 멈춘다(CDP 30초 시간 초과). 메뉴는 a 태그 click()으로 열리고 로그아웃되지 않는다(직접 주소 이동은 로그아웃).
- 사업용 카드 화면은 카드번호 16자리를 가림 없이 주고, 같은 화면에 공제여부를 저장하는 [변경하기]가 있다.

## 결정

1. **조회 화면 읽기는 금고가 한다(`report.readScreen {runId, targetId, screen, period:{from,to}}`).** 화면 표(메뉴 id, 조회 actionId, 기간 칸, [조회], 표 id와 열, 총 건수, 쪽 링크)는 금고 `report/screens.ts`에 고정이다. 패키지와 엔진은 화면, 스크립트, 열을 바꿀 수 없고 자료 종류와 기간만 넘긴다. 금고는 기간이 화면 단위에 맞지 않으면(달 화면에 두 달, 분기 화면에 두 분기, 날짜 범위 3개월 넘음) 화면에 들어가지 않고 거부한다.
2. **순서: 메뉴 클릭 → 화면 표지 → 기간 → alert 가로채기 → [조회] → 쪽 넘기며 읽기.**
   - 메뉴를 누르기 전에 지금 화면의 표지 요소에 옛 표시를 달고, 새로 그린 표지만 다 떴다고 본다(같은 화면을 다시 열 때 옛 화면을 읽지 않게).
   - `window.alert`와 `window.confirm`을 먼저 가로챈다(confirm은 언제나 취소). 누르기는 setTimeout으로 비동기다. 조회가 끝났는지는 그 화면 조회 요청(actionId)의 XHR loadend 횟수와 처리 중 표시로 본다(고정 지연 없음).
   - 결과 없음 안내는 0건이다(그때 표에 줄이 남아 있으면 앞 조회의 줄이라 `grid_stale`로 실패). 다른 안내(점검, 세션 만료)는 `portal_alert`로 실패하고 금고 로그에 앞 80자를 남긴다.
   - 쪽은 `pglNavi_page_{n}`을 눌러 넘긴다. 총 건수와 읽은 줄 수가 같아야 끝이다. 쪽이 안 바뀌면(`page_not_moved`), 총 건수가 바뀌면(`total_changed`), 줄이 모자라면(`rows_short`) 실패다. 쪽 120개, 줄 5,000개가 상한이다.
3. **읽기만 한다.** 화면 표에 있는 단추는 메뉴, 탭, 기간 라디오, [조회], 쪽 링크뿐이다. 사업용 카드 [변경하기](`trigger19`)와 행마다 공제여부 select는 표에 없어 누를 수 없다. 카드번호는 페이지 안 스크립트에서 끝 4자리만 남겨 금고 밖으로 전체 번호가 나가지 않는다.
4. **줄 모양은 `bank.hometaxSync`가 받는 모양이다(#542).** 세금계산서 `{approvalNo, writtenOn, total, supply, tax, item, buyerBizNo, supplierBizNo, 상대방 상호와 대표자}`(목록의 상호와 대표자는 상대방 것), 현금영수증 `{day, approvalNo, amount, supply, tax, canceled, (매입) cpBizNo, cpName, deductible}`(취소거래도 금액이 양수라 canceled로 표시), 사업용 카드 `{usedOn, merchant, merchantBizNo, cardLast4, approvalNo, amount, supplyAmount, vatAmount, canceled, deductible}`, 카드 매출 `{month, issuer, count, amount}`(카드사 자료는 자료 종류, 판매대행은 PG사 상호). 꼭 있어야 하는 칸(날짜, 금액, 승인번호)이 읽히지 않으면 그 구간 전체가 `cell_unreadable`로 실패한다. 줄을 조용히 빼지 않는다.
5. **IR rev v1.4.1: `report_sync` 스텝과 입력 형식 `report_plan`.** `report_sync {plan: '$inputs.plan'}`은 계획(자료 종류와 기간, 80개까지)의 구간마다 금고 포트로 읽고 받는 곳(sink)에 줄이나 실패 코드(`report.<사유>`)를 넘긴다. 구간 하나의 실패는 다음 구간을 막지 않는다. 금고가 홈택스에 닿지 못한 사유(대상 없음, 메뉴 없음, 화면 잃음, 시간 초과)면 남은 구간을 같은 코드로 넘기고 더 돌지 않는다. 하나도 못 받으면 실행이 실패로 끝난다. plan은 필수 입력 `$inputs.이름` 하나다(V-26). `report_sync`가 있는 플레이북은 effects가 비고 gate, submit, human_commit, send_email이 없어야 한다(V-27).
6. **패키지 `hometax.report.sync` 1.0.0.** 로그인은 발급 패키지 스텝을 가져오고 그 뒤 `report_sync` 하나와 end다. commitEndpoints는 비우고 조회 호스트(tecr, teht의 `wqAction.do`, `permission.do`)는 knownEndpoints에 둔다. 실행은 `RunService.startReport {runId, plan}`이고 발급 한도와 발급 잠금을 쓰지 않는다.

## 아직 하지 않은 것

- 받는 곳 연결: `reportSink`를 `BankService.hometaxSync`에 잇고(구간마다 `{kind, from, to, rows | code, trigger}`), 잠금 풀기 뒤 실행(`unlock` 근거, `hometaxPlan`)과 제품 패키지 목록 `PRODUCT_PACKAGES`에 넣는 일은 #542가 합쳐진 뒤 한다(PR 쌓기 금지).
- 맥북 실화면 확인: 세금계산서 날짜 칸이 DOM 값과 이벤트(또는 컴포넌트 setValue)로 바뀌는지, 쪽 링크를 누르면 같은 actionId 요청이 다시 나가는지, 쪽 묶음(1~10) 너머의 쪽, 결과 없음 안내 문구, 카드 매출 카드사별 표(`grdCrdcTrsBrkdMateAdmDVOList`) 값 모양(실측 사업자는 0행), 판매대행 금액 열로 `sumTipExclAmt`가 맞는지.
- 패키지 서명과 게시는 대표(Touch ID).

## 영향

- 앱: 금고 `report.readScreen`과 IR v1.4.1을 아는 앱이 먼저 배포돼야 한다. 옛 앱은 `report_sync`를 모르는 IR이라 패키지를 거부한다.
- 시험: `tests/vault-report-read.test.ts`(가짜 홈택스 여섯 화면, 쪽 넘김, 카드번호 가림, 안내 갈래, 기간 거부), `tests/report-dryrun.test.ts`(로그인부터 받는 곳까지 건조 실행).
