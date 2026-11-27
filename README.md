# 택스오프 — 홈택스 발급·조회를 대신하는 PC 앱

자영업자·중소기업·스타트업이 **본인 PC에서, 본인 인증수단으로** 홈택스(전자세금계산서)와 정부24(민원서류) 업무를 처리하도록 돕는 로컬 에이전트 하네스. 비밀값은 기기 밖으로 나가지 않고, 서류는 로컬 보관 + 종단간 암호화 백업, 모델은 월 구독으로 제공한다.

> 모토: 본인의 데이터는 본인이 갖고 있어야 한다 — 소버린 AX

## 저장소 구성

| 경로 | 내용 | 상태 |
|---|---|---|
| [AGENTS.md](AGENTS.md) | 모든 에이전트(Claude 스레드, Devin, 사람) 공통 규칙: 먼저 읽을 것, PR 흐름, 검증, 바꾸지 않는 결정 | 2026-11-24 |
| [sovereign-ax/handover/](sovereign-ax/handover/working-notes.md) | 작업 방식 노트(대표 개입에서 나온 규칙), 코드 품질 원칙, 인계 문서, 매일 점검 기록 | 살아 있는 문서 |
| [poc/](poc/README.md) | 제품 코드: PC 앱(Electron), 엔진, 금고, DB, 대화 코어, 서버(`poc/services/`: 계정, 게이트웨이, 릴레이, 푸시). 폰 앱은 별도 저장소 `LAF-labs/taxoff-mobile` | 운영 배포 중 |
| [sovereign-ax/README.md](sovereign-ax/README.md) | 기획서 입구: 원칙, 사업 범위, 확인된 외부 사실, 결정 사항, Phase 1 "세 약속"과 단서 | v1.2 + 설계 v1.3 결정 + AUDIT-D 결정(2026-11-03) |
| [sovereign-ax/01-business-plan.md](sovereign-ax/01-business-plan.md) ~ [06-feasibility.md](sovereign-ax/06-feasibility.md) | 사업·서비스 기획, 아키텍처 개요, 로드맵, 접근 허용·봇탐지, 가능성 검토 | v1.2 (기준 시나리오·검수 반영) + 서류 카탈로그 반영(ADR-018) |
| [sovereign-ax/07-document-catalog.md](sovereign-ax/07-document-catalog.md) | 사업자 서류 카탈로그: 공고문 36건 수요 집계, 상황별 세분화, 플레이북 우선순위 근거 | v0.1 (2026-10-30) |
| [sovereign-ax/08-screen-plan.md](sovereign-ax/08-screen-plan.md) | 화면·기능 기획: 화면 34개(PC 27·모바일 7), 채팅 온보딩, 작업 상태 흐름, 예외 상태, Claude Design 전달 사항 | v0.1 (2026-10-30) |
| [sovereign-ax/09-bank-matching.md](sovereign-ax/09-bank-matching.md) · [11-cash-flow.md](sovereign-ax/11-cash-flow.md) | 돈 맞추기(받을 돈, 계좌 연결) 1단계 · 낼 돈(매입)과 현금흐름 분석 | 09 v0.1 구현됨 · 11 v0.1 제안 (2026-11-16) |
| [sovereign-ax/design-system/](sovereign-ax/design-system/README.md) | 디자인 시스템: 토큰(라이트·다크), 데이터 위계, 컴포넌트, 문구 규칙 | v2.1 (2026-11-18), v2.2 제안 (2026-11-24) |
| [sovereign-ax/design/](sovereign-ax/design/00-overview.md) | 개발 설계서 D00~D19, JSON 스키마, ADR(목록은 [adr/README.md](sovereign-ax/design/adr/README.md)) | ADR는 계속 더한다. 번호와 목록은 adr/README.md 한 곳 |
| [sovereign-ax/legal/](sovereign-ax/legal/README.md) | 이용약관·개인정보 처리방침(F-06): 전문은 사이트 `/terms`·`/privacy`, 채울 회사 정보·코드 불일치·변호사 확인 목록 | 초안 (2026-11-16) |
| [sovereign-ax/research/](sovereign-ax/research/) | 리서치 노트 R1~R8(Sonnet), R9 공고문 제출서류 집계·R10 서류 발급 사실표, 검수 REVIEW-A~E와 공격표면 감사 AUDIT-A/B/C, 설계 v1.3 + PoC 코드 감사 AUDIT-D(Opus) | 참고 |

기획 최종본은 Claude Docs 아티팩트([최종본 요약 + 탭 9개(개발 설계 요약 v1.3, 공격표면 감사·소버린 결정 포함)](https://claude.ai/artifact/CPYTrcP1Rb1rn35ig7bEPv))로도 볼 수 있으며 이 저장소의 문서와 같은 내용이다. 화면·기능 기획은 와이어프레임이 들어간 [별도 Claude Docs](https://claude.ai/artifact/9rBKqQmQ3Thoaii3r1aMpi)로, 디자인 시스템은 미리보기가 렌더되는 [Design System 아티팩트](https://claude.ai/artifact/EqjRNi8i9CYd4qkSo9qz3N)로도 볼 수 있다.

제품 코드는 `poc/`에 있다. 이름은 PoC 스파이크(ADR-017)에서 왔지만, 지금은 이 코드로 PC 앱을 만들어 운영에 내보낸다. 작업판은 https://project.laf-co.com/p/taxoff 이다.

## 읽는 순서

에이전트로 일하러 왔다면 [AGENTS.md](AGENTS.md)부터 읽는다.

1. 기획 요약 → `sovereign-ax/README.md`
2. 왜 이 사업인가 → `01-business-plan.md`, `06-feasibility.md`
3. 무엇을 만드는가 → `02-product-spec.md`, 어떤 서류부터인가 → `07-document-catalog.md`, 어떤 화면인가 → `08-screen-plan.md`, 어떻게 보이는가 → `design-system/`
4. 어떻게 만드는가 → `design/00-overview.md`부터 번호순, 결정 이유는 `design/adr/`
5. 근거가 궁금하면 → `research/`

## 문서 규약

- 한국어. 숫자는 출처가 있으면 출처, 없으면 "가설"로 표기.
- 설계 변경은 ADR 추가 또는 갱신으로 남긴다.
- 비밀값·실제 사업자 데이터는 어떤 문서에도 넣지 않는다.
