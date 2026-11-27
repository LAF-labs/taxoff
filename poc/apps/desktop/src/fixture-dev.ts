import { startFixtureMode } from './fixture-mode.ts';
import { MOCK_CP_CERT, MockOnboardingPorts } from './onboarding-mock.ts';
import type { ShellDev } from './shell-app.ts';

/** 시험용 가짜 홈택스(ADR-039)로 셸을 띄우는 연결. e2e만 쓴다. */
export const FIXTURE_DEV: ShellDev = {
  startFixture: startFixtureMode,
  onboarding: () => new MockOnboardingPorts({ saveProfile: async () => {} }),
  cpCert: MOCK_CP_CERT,
};
