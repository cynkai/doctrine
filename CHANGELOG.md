# Changelog

버전은 [SemVer](https://semver.org/lang/ko/)를 따른다 — 기능 추가는 가운데 자리(1.1.0), 버그 수정만 있으면 끝자리(1.1.1).

## [Unreleased]

## [1.1.0] — 2026-10-05

### Added
- **피할 역할군.** 의도 스키마에 `avoidRole`을 추가했다. "앞에 방패 든 애는 무시하고 지나가" → 전열형은 다른 적이 남아 있는 동안 치지 않는다(그것만 남으면 그대로 싸운다). 명령이 피하라는 역할군을 교리가 노리면 명령이 이긴다.
- `scripts/intent-proof.js` (18) — LLM 응답 → 정책 변환, 타겟 선택, 교리와의 우선순위를 전투 시뮬레이션으로 확인.

### Fixed
- LLM이 `retreatHpPct`·`aggression`을 퍼센트(60)로 내면 1로 잘려 체력이 가득해도 후퇴하던 문제. 1보다 크면 퍼센트로 읽어 0.6으로 바꾸고, 프롬프트에도 0~1 비율이라고 명시했다.
- 교리 생성 프롬프트: 피하라는 명령에서 그 역할군을 교리로 만들지 않는다.

### Changed
- CI: `actions/checkout`·`setup-node` v5 (Node 20 런타임 폐기 경고), proof 4종.

### Known issues
- 교리는 "피하기"를 담지 못한다 — 피하라는 명령에서 배운 교리는 다른 역할군을 우선 대상으로 추측한다.

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

[Unreleased]: https://github.com/cynkai/doctrine/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/cynkai/doctrine/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/cynkai/doctrine/releases/tag/v1.0.0
