# ADR-063. 일괄발급 파일은 금고가 만들어 넣고, 변환 목록은 줄마다 대조한다

> 상태: 제안(2026-11-24). 대표 요청(2026-11-24): "양식 없이 가능하되 제공도 해주면 좋을듯. 우리가 잘못 신고했다가 가산세 나오면 안되니까 정확하게 입력할 필요가 있지. 우리가 책임 못 지니까 신뢰가능하게 줘야해."
> 실측: 2026-11-24 맥북 Chrome, 홈택스 「전자(세금)계산서 일괄발급」(UTEETBAA77). 발급 단추는 누르지 않았다(확인창 문구와 요청 순서는 화면 스크립트에서 읽었다). 값을 가린 기록은 `/mnt/project-files/hometax-ref/bulk-probe.md`.
> 잇는 결정: [ADR-059](ADR-059-bulk-issuance-one-approval.md)(11건부터 일괄발급 화면, 승인 한 번), [ADR-025](ADR-025-poc3-real-account-safety-baseline.md)(금고 경계), D05 §3.3(엔진의 `DOM.setFileInputFiles` 거부).

## 맥락

- 일괄발급 화면은 엑셀 파일을 받아 [엑셀파일 변환하기]로 목록을 만들고, [일괄발급(50건)]이 체크된 줄을 한 요청으로 발급한다. 묶음 전체가 같이 성공하거나 같이 실패한다(실패하면 목록을 비운다).
- 파일 칸은 `input[type=file]` 하나다. 엔진은 중계가 `DOM.setFileInputFiles`를 거부해 파일을 넣을 수 없다. 사용자 파일을 그대로 올리면 우리가 읽은 값과 홈택스가 읽은 값이 다를 수 있다.
- 홈택스 양식: 시트 「엑셀업로드양식」, 6행 머리글, 7행부터 자료, 59열(A~BG). 필수 A, B, C, E, F, K, M, N, T, U, W, AB, AC, BG(+X 품목). 확장자는 소문자 `.xlsx`만 받는다. 앱이 만든 최소 xlsx(공유 문자열, 글자 서식 numFmtId 49, 2~5행 빈 줄)가 실화면에서 그대로 변환됐다(2줄, 값 그대로).
- [일괄발급]을 누르면 줄마다 확인창이 뜰 수 있다(발급기한 경과, 공급받는자 폐업, 「취소하시면 제외됩니다」). 그 뒤 본 확인창 「전자세금계산서를 일괄발급하시겠습니까? … (총 건수: N, 총 합계금액: X)」, 인증 유형 창(UTEETZZA08, 건별발급과 같은 공통 창), 인증서 서명 한 번, `ATEETBAA004C15`(XML) → `C16`(발급) → `C13`(메일) 순이다.

## 결정

1. **파일은 금고가 만든다(`bulk.upload {runId, targetId, sheet}`).** 엔진은 검사한 줄 값만 넘긴다. 금고가 다시 검사하고(사업자번호 검사 숫자, 바이트 길이, 허용 글자, 수식 시작 글자 금지, 작성일, 금액, 공급자 ≠ 받는 곳) 고정 모양 xlsx를 자기 폴더 `upload/`(0700, 파일 0600, 10분 뒤 지움)에 만들어 그 탭의 일괄발급 화면(표 `#mf_txppWframe_grdBndlEtxivIsn`이 있고 파일 칸이 정확히 하나)에만 넣는다. 사용자 파일, 다른 경로, 다른 화면에는 넣지 않는다. 결과는 줄 수와 sha256만 엔진에 준다.
2. **변환 목록은 금고가 읽는다(`bulk.readGrid`).** 금고에 고정된 스크립트가 표 API(`$p.getComponentById(...).getRowCount/getCellData/getCheckedIndex`)로 열 10개(체크, 작성일, 받는 곳 번호와 상호와 대표자, 공급가액, 세액, 승인번호, 영수/청구, 공급자 번호)를 100줄까지 읽는다. 패키지와 엔진은 스크립트를 바꿀 수 없다.
3. **IR rev v1.4.0: `upload`, `grid_check`, `submit.expectConfirmVars`, 입력 형식 `invoice_rows`, `party`.**
   - `upload`와 `grid_check`의 rows, supplier는 필수 입력 `$inputs.이름` 하나다(V-26). 화면에서 읽은 값으로 파일을 만들지 않는다.
   - `grid_check expect:converted`: 건수가 같고, 줄마다 공급자 번호, 받는 곳 번호, 상호, 대표자, 작성일, 공급가액, 세액, 영수/청구가 입력과 같고, 체크돼 있고 잠기지 않았고 승인번호가 비었는지. 하나라도 다르면 승인 전에 멈춘다.
   - `grid_check expect:issued`: 줄마다 승인번호를 읽어 `bind`(쉼표 목록)에 둔다.
   - `expectConfirmVars`: 확인창 패턴의 `{count}`, `{total}`을 입력 값으로 바꿔 맞춘다(V-24가 패턴과 변수를 맞춘다). 줄 확인창은 패턴이 달라 취소되고 그 줄이 빠지면 본 확인창의 건수가 달라져 그것도 취소된다. 그러면 아무것도 발급되지 않는다.
   - 게이트를 지배하는 `grid_check converted`가 있으면 카드 필수 칸 supplierBizNo 되읽기(V-03h)와 verify.match의 `$readback`(V-04)을 묶음 입력 줄 값으로 대신한다. 줄마다 화면과 맞춘 값이기 때문이다.
4. **확인창 거절은 바로 끝낸다.** 무장된 확인창을 취소했고 2초 안에 맞는 확인창이 뜨지 않으면 서명 창을 기다리지 않고 확정 조회로 간다(`submit.confirm_declined`). `expectConfirm`은 "포털은 이 확인창을 수락해야만 커밋한다"는 패키지 선언이라, 정한 횟수와 시간(정책 lookups, minElapsedMs) 동안 조회에 새 건이 없으면 실패 신호 대신 이것을 근거로 not_committed로 본다. 조회가 실패하면 그대로 확인 필요(in_doubt)다. not_committed면 `bulk.not_issued`로 끝나고 다시 올리지 않는다. end 스텝의 `code`를 실행 결과 코드로 낸다(수정발급 `amend.reason_unsupported`도 같이 나온다).
5. **발급 확인은 첫 줄 하나로, 거래처로 걸러 한다.** 묶음이 같이 성공하므로 첫 줄(받는 곳 번호, 작성일, 공급가액, 세액)을 기준선과 비교하고, 확인되면 목록의 승인번호를 줄마다 읽는다. 공용 `hometax.invoice.lookup`은 쪽 크기 10에 총 건수를 읽지 않아 하루 10건을 넘으면 결론을 못 낸다. 새 조회 패키지 `hometax.invoice.buyer_lookup` 1.0.0은 번호 종류 「사업자등록번호」 + 번호 칸(키보드 입력, 하이픈 없는 10자리)으로 거르고, 쪽 크기 50을 조회 전에 고르고, 총 건수(`txtTotal`)가 읽은 줄 수와 같을 때만 결론을 낸다(2026-11-24 맥북 실측, 읽기만, `/mnt/project-files/hometax-ref/list-probe.md`). 한 거래처가 하루 50건을 넘으면 결론을 못 내고 확인 필요로 남는다(쪽 넘기기는 다음).
6. **줄 기록 `invoice_bulk_rows`(DB 이전 v17).** 실행, 줄 번호, 사업 키, 거래처 번호, 작성일, 금액, 상태(running, committed, failed, in_doubt), 승인번호. 건별 발급의 같은 건 막기(`$dup.businessKey`)와 묶음 시작의 같은 건 막기(`bulk.duplicate:n`)가 이 표와 장부를 같이 본다. 장부에는 묶음 한 줄(사업 키는 줄 키 목록의 해시)만 둔다.
7. **패키지 `hometax.invoice.bulk` 1.0.0**(제품 id 목록 `PRODUCT_PACKAGES.bulk`). 로그인과 서명 창은 발급 패키지에서 가져온다. 승인 카드는 `bulk.confirm`(요약 칸 bulkCount, 줄은 `$bulk.rows`). 지난 날짜(발급기한 확인이 필요한 줄)는 시작에서 막는다(`bulk.issue_late:n`).

## 아직 확인하지 않은 것(실제 발급 예행 몫)

- 서명 뒤 화면: 승인번호가 목록 줄마다 바로 채워지는지(스크립트상 `setAprvNo`), 성공 알림 문구가 실측과 같은지.
- 간편인증 갈래(UTEETZZA07)의 완료 표지.
- 받는 곳 번호 칸이 목록에 하이픈 붙은 모양인지(대조는 숫자만 본다).
- 실제 발급 예행은 대표가 직접 쓴 문장이 있어야 한다. 처음은 2~3건(11건 미만이라도 이 패키지로 돌리는 예행 모드).

## 영향

- 앱: 금고 `bulk.upload`, `bulk.readGrid`가 든 앱이 먼저 배포돼야 한다. 옛 앱은 `upload` 스텝을 모르는 IR이라 패키지를 거부한다.
- 패키지 게시: `hometax.invoice.bulk` 1.0.0과 `hometax.invoice.buyer_lookup` 1.0.0 서명과 게시는 대표(Touch ID).
- 시험: ADR-059 시험 목록 중 11건 묶음, 확인할 건(폐업)을 뺀 확인창, 변환 목록 불일치를 가짜 홈택스 건조 실행으로 둔다(`tests/bulk-dryrun.test.ts`).
