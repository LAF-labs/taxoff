-- 계정 서비스 v13: 비밀번호 표를 지운다(ADR-061 결정 1). 비밀번호 경로가 없는 판을 배포한 뒤에 적용한다(옛 판은 정리 때 이 표를 쓴다).
-- 세션·갱신 토큰의 auth_method 'password'는 이미 받은 것이 만료될 때까지 남는다(CHECK는 그대로 둔다).
DROP TABLE IF EXISTS reset_codes;
DROP TABLE IF EXISTS pw_locks;
DROP TABLE IF EXISTS pw_creds;
