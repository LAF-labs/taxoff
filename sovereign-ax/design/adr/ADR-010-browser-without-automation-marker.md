# ADR-010 브라우저에 자동화 표식을 남기지 않는다

상태: 채택 · 2026-10-28

CDP로 구동한 Chrome은 자동화 UI 모드가 켜져 `navigator.webdriver`가 `true`가 된다(포트로 붙여도 마찬가지다). 홈택스는 이 값이 있으면 공동인증서 서명값을 주지 않아 발급이 멈춘다.

- 앱 안 보기는 `Emulation.setAutomationOverride({ enabled: false })`, 설치 Chrome 판은 `--disable-blink-features=AutomationControlled`.
- 페이지에 값을 심지 않는다. 값은 Blink가 낸다. `--enable-automation`은 쓰지 않는다(화면 표시줄).
- 기동 자기 점검은 표식이 없어야 통과다. 값이 보이면 실행 탭을 막고 `vault.webdriver_selfcheck_failed`를 남긴다.
- 남는 차이(UA의 Electron 삭제 표기, `navigator.userAgentData.brands`의 Chromium만)는 문서에 적고, 식별자를 요구하면 UA 접미사로 답한다.
- 후처리 모드는 자동화 프로필 Chrome을 쓰지 않고 사용자의 기본 브라우저로 연다.
