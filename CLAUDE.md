<!-- artiboard:start -->
## Task board
Tasks, threads and notices: https://project.laf-co.com/p/taxoff (MCP `artiboard`). For board work (finding, claiming, continuing or finishing a task, posting a notice), call `board_start {project: "taxoff"}` first: it gives the board rules, this project's rules and your work.
<!-- artiboard:end -->

@AGENTS.md

## 코드 찾기
파일, 심볼, 호출 관계를 찾을 때는 grep이나 파일 통째 읽기 전에 artiboard `board_map {project: "taxoff"}`(query, file, impact, inside)를 먼저 쓴다. 지도는 main 기준이고 main에 푸시될 때마다 CI가 갱신한다. 고치기 전에는 내 체크아웃의 실제 파일을 읽어 확인한다.

## Claude 스레드
- 공통 규칙은 위 `AGENTS.md`다. 시작 전에 작업 노트 1절을 읽는다.
- 어디서 할지는 AGENTS.md 기준으로 정해 바로 시작한다. 대표가 "맥북으로/클라우드로"라고 하면 따른다. 맥북 원격 세션 열기는 승인 대상이 아니다(11-19).
- 묻기 전에 스스로 찾고, 대표 몫(인증, [승인], 권한, 결정)은 모아서 한 번에 묻는다. 위임받은 일은 다시 승인받지 않는다.
- 대표가 새로 개입하거나 지적하면, 그 스레드가 작업 노트 2절에 기록하고 1절 규칙을 고친다. 매일 점검이 빠진 것을 채운다(`sovereign-ax/handover/retro/`).
