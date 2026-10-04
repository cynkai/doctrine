<div align="center">

# DOCTRINE · 교리

### *Every order becomes a doctrine.*

**플레이어는 병사를 성장시키지 않는다. AI 사령관의 사고방식을 성장시킨다.**

[![CI](https://github.com/cynkai/doctrine/actions/workflows/ci.yml/badge.svg)](https://github.com/cynkai/doctrine/actions/workflows/ci.yml)
![LLM: OpenAI (bring your own key)](https://img.shields.io/badge/LLM-OpenAI_·_your_own_key-10a37f)
![Rule-based Fallback](https://img.shields.io/badge/Fallback-Rule--based-6b7280)
![Natural Language RTS](https://img.shields.io/badge/Genre-Natural_Language_RTS-ffb64a)
![No Dependencies](https://img.shields.io/badge/Dependencies-0-brightgreen)

<img src="assets/hero.png" width="720" alt="STAGE 3 — 명령 없이 학습한 교리가 스스로 발동해 승리" />

<sub>STAGE 3 — 플레이어는 <b>침묵</b>했다. 사령관이 스스로 「지원형 우선 제거」 교리를 발동해 승리. (LLM 모드, 제출 당시 gpt-4o)</sub>

NAN 2026 · NHN 게임 × AI 해커톤 예선 제출작에서 출발해 버전을 올려 가는 프로젝트

**[▶ 브라우저에서 바로 플레이](https://doctrine-five.vercel.app)** <sub>(규칙 기반 모드 — LLM 모드는 [자기 키로 로컬 실행](#run))</sub>

</div>

> **English summary.** A small real-time tactics game where you command in plain Korean. After each battle the AI commander infers the *intent* behind your order and generalizes it into a permanent doctrine at the level of unit roles ("remove supports that amplify enemies"), which then fires on its own in later battles, even when you say nothing. An LLM reads the intent; its output is constrained by a strict JSON schema to roles and traits the game knows. Without an API key the game falls back to a rule-based parser that only understands game terms. Zero dependencies: vanilla JS + a tiny Node proxy.

---

## Why?

기존 RTS는 명령이 곧 행동이고, 전투가 끝나면 사라진다.
**DOCTRINE**에서 명령은 사라지지 않는다 — AI 사령관이 그 명령의 **의도**를 추론하고,
유닛 이름이 아니라 **역할군(원리)** 수준으로 일반화해 **영구적인 전술 교리**로 저장한다.
그 교리는 다음 전투에서 **플레이어가 아무 말도 하지 않아도** 스스로 적용된다.

### 왜 LLM이 아니면 안 되는가

사람은 사전에 있는 말로 말하지 않는다. 아래는 **실제 측정값**이다 (`/api/intent`, 문장마다 3회).

| 플레이어 입력 | Rule-based | LLM (gpt-4o · gpt-5.4-mini) |
|---|:---:|:---:|
| "적 힐러에게 화력을 집중해라" | ✅ | ✅ `support` |
| "쟤 하나 때문에 안 죽잖아" | ❌ | ✅ `support` |
| "뒤에 깃발 든 애 거슬려" | ❌ | ✅ `support` |
| "뒤부터 죽여" | ❌ | ✅ `ranged` |
| "안녕하세요" | ❌ | ❌ *(이해 못 함)* |

이 표의 문장은 예시일 뿐 정답 목록이 아니다. 표에 없는 문장도 같은 방식으로 해석한다:

| 처음 보는 입력 | Rule-based | LLM (gpt-5.4-mini) |
|---|:---:|:---:|
| "저 지팡이 든 놈이 자꾸 피 채워줘" | ❌ | ✅ `support` + 화력 집중 |
| "멀리서 활 쏘는 애들 짜증나" | ❌ | ✅ `ranged` |
| "오늘 점심 뭐 먹지" | ❌ | ❌ *(전술 명령 아님)* |
| "앞에 방패 든 애는 무시하고 지나가" | ❌ | ⚠️ [알려진 한계](#알려진-한계) |
| "천천히 하자, 다치지 말고" | ❌ | ⚠️ [알려진 한계](#알려진-한계) |

정규식은 사전에 있는 표현만 잡는다. LLM은 임의의 자연어에서 의도를 읽고, 없는 의도는 지어내지 않는다.

---

## Architecture

```
   Player Prompt   →   Intent Extraction   →   Doctrine Generator   →   Doctrine Memory
   "쟤 하나 때문에…"      /api/intent             /api/doctrine            localStorage
                        targetRole: support     원리로 일반화 + 예외      다음 전투 자동 적용
```

출력은 `json_schema`(strict)로 게임이 아는 role·trait enum에 제약된다 —
LLM은 게임 규칙을 지어내지 못하고, 오직 **의도 해석**만 담당한다.
키가 없으면 규칙 기반 폴백으로 자동 강등되며, 화면에 추론 백엔드를 항상 표시한다(`OPENAI · gpt-5.4-mini` / `LOCAL · 규칙 기반`).

---

## Run

```bash
# 키 없이 (규칙 기반 폴백)
node server/proxy.js                              # → http://localhost:8731

# LLM 추론 — 자기 OpenAI 키를 넣는다
OPENAI_API_KEY=sk-... node server/proxy.js
```

의존성 0, Node 18 이상. 키는 서버 프로세스에만 있고 브라우저로 내려가지 않는다.

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `OPENAI_API_KEY` | (없음) | 없으면 규칙 기반 모드 |
| `COMMANDER_MODEL` | `gpt-5.4-mini` | 예선 제출 당시는 `gpt-4o`. 둘 다 위 표와 같은 결과 |
| `PORT` | `8731` | |
| `ANTHROPIC_API_KEY`, `COMMANDER_PROVIDER=anthropic` | | 같은 계약의 Anthropic 어댑터 (v1.0.0에서 검증하지 않음) |

### 직접 배포할 때

`api/`는 Vercel 함수다. 키를 넣고 공개 배포하면 누구나 그 키로 호출할 수 있으므로, 서버(`server/guard.js`)가 다음을 강제한다:

- 클라이언트가 보낸 값을 그대로 프롬프트에 넣지 않는다 — 명령 200자, 목록 개수·길이 제한, role/trait는 서버가 아는 값만
- 본문 16KB 초과 → 413, IP당 분당 20회·하루 300회 초과 → 429, 응답은 800토큰 상한

레이트 리밋은 인스턴스 메모리라 서버리스에서는 최선 노력이다. 키를 넣어 배포한다면 OpenAI 프로젝트에 **하드 사용 한도**를 함께 걸어 두자. 위 플레이 링크는 키 없이 배포되어 있다.

### 테스트

```bash
node scripts/proof.js           # 교리 학습·일반화·예외 (30)
node scripts/conflict-proof.js  # 교리 충돌 해소 (23)
node scripts/guard-proof.js     # 공개 배포 방어선 (22, fetch 스텁)
```

CI가 Node 20·22에서 셋 다 돌린다.

---

## 알려진 한계

- **"피하라"를 표현할 칸이 없다.** 의도 스키마는 "어떤 역할군을 먼저 칠지"만 담는다. "방패 든 애는 무시하고"에 LLM이 정반대인 `frontline`을 고른다.
- **후퇴 기준 단위가 어긋난다.** "다치지 말고"에 LLM이 `retreatHpPct`를 퍼센트(60)로 내기도 하는데, 게임은 0~1을 기대해 1로 잘린다 — 체력이 가득해도 후퇴한다.

둘 다 v1.1.0에서 고친다.

---

## 버전

- [`hackathon-submission`](https://github.com/cynkai/doctrine/tree/hackathon-submission) — 2026-07-18 예선 제출 시점
- 이후 변경은 [CHANGELOG](CHANGELOG.md)와 [Releases](https://github.com/cynkai/doctrine/releases)에 기록한다.

## 문서 (예선 제출 자료, gpt-4o 기준)

- [게임 소개 및 설명 문서](docs/DOCTRINE_게임소개서.pdf)
- [AI 활용 기술 문서 — 왜 LLM이 아니면 안 되는가](docs/DOCTRINE_AI활용기술문서.pdf)
- [포트폴리오 · 참고자료 — 설계 여정 · 로드맵](docs/DOCTRINE_포트폴리오.pdf)

---

> **This project does not use AI to replace the player.
> It uses AI to remember, generalize, and evolve the player's strategy.**

## License

[MIT](LICENSE)
