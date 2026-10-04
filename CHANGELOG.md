# Changelog

버전은 [SemVer](https://semver.org/lang/ko/)를 따른다 — 기능 추가는 가운데 자리(1.1.0), 버그 수정만 있으면 끝자리(1.1.1).

## [Unreleased]

## [1.0.0] — 2026-10-05

예선 제출본을 공개 레포로 정리한 첫 버전.

### Changed
- 기본 모델 `gpt-4o` → `gpt-5.4-mini` (README 의도 표 15/15 동일, 더 빠르고 저렴). `COMMANDER_MODEL`로 바꿀 수 있다.
- 플레이 링크는 키 없이 배포한다 (규칙 기반). LLM 모드는 각자 자기 키로 로컬 실행.
- 제출 문서 PDF·LICENSE의 연락처를 `cynkai`로 바꿨다.

### Added
- 공개 배포 방어선 `server/guard.js` — 서버가 프롬프트 입력을 다시 만들고(명령 200자, role/trait enum은 서버 소유), 본문 16KB 제한, IP별 레이트 리밋, 출력 800토큰 상한.
- 명령 입력창 `maxlength="200"`, 타이틀 화면 버전 표시.
- `scripts/guard-proof.js`와 CI (Node 20·22에서 proof 3종).

### Known issues
- 의도 스키마에 "피할 역할군"이 없어 "방패 든 애는 무시하고"를 반대로 해석한다.
- LLM이 `retreatHpPct`를 퍼센트로 내면 1로 잘려 체력이 가득해도 후퇴한다.

## 0.x — 예선

- 2026-08-13 — Vercel 함수로 AI 백엔드 배포, 교리 충돌 해소 (`conflict-proof.js`).
- 2026-07-18 — NAN 2026 예선 제출 (`hackathon-submission` 태그).

[Unreleased]: https://github.com/cynkai/doctrine/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/cynkai/doctrine/releases/tag/v1.0.0
