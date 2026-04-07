# SOOP 채금 스캐너 v0.2.0 — 기능 리서치

> **파일**: [soop-ban-scanner.js](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js)  
> **버전**: `0.2.0`  
> **작성일**: 2026-04-07  
> **적용 URL**: `https://play.sooplive.com/*`, `https://vod.sooplive.com/*`

---

## 1. 개요

SOOP(구 아프리카TV) 라이브/VOD에서 **채팅금지(채금)** 내역을 실시간으로 탐지·누적하고, 별도 패널 UI에 표시하는 **Tampermonkey/Greasemonkey 유저스크립트**입니다.

### v0.2.0의 핵심 변경 원칙

> [!IMPORTANT]
> **데이터 레이어 ↔ UI 레이어 완전 분리**
> - `banLogs[]` 마스터 배열: 패널 열림/닫힘과 **무관하게 항상 누적**
> - 패널 DOM: `banLogs[]`를 읽어 **표시만** 함
> - 패널을 다시 열 때 [renderAllLogs()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#482-497)로 전체 내역 일괄 복원

---

## 2. 아키텍처 개요

```
┌──────────────────────────────────────────────────────────┐
│                   SOOP 채금 스캐너 v0.2.0                 │
│                                                          │
│  [통신 후킹 레이어]              [데이터 레이어]            │
│  ┌────────────────┐             ┌───────────────────┐   │
│  │ hookWebSocket  │────────────▶│ banLogs[]          │   │
│  │ hookXHR        │──(Phase2)──▶│ stats{}            │   │
│  │ hookFetch      │──(Phase2)──▶│ logIdCounter       │   │
│  └────────────────┘             └─────────┬─────────┘   │
│                                           │              │
│                                  [UI 레이어]              │
│                                  ┌────────▼──────────┐  │
│                                  │ 패널 (#soop-ban-panel)│
│                                  │ 통계 바 (4종)       │  │
│                                  │ 로그 목록 (스크롤)   │  │
│                                  │ 재오픈 탭           │  │
│                                  └───────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## 3. 전역 상태

| 변수 | 타입 | 역할 |
|------|------|------|
| `banLogs` | `Array` | 채금 로그 마스터 배열 (최신순 `unshift`) |
| `logIdCounter` | `number` | 로그 항목 자동 증가 ID |
| `stats` | `Object` | `{ total, spam, abuse, etc }` 분류별 카운터 |
| `panelEl` | `HTMLElement` | 패널 루트 DOM 참조 |
| `logListEl` | `HTMLElement` | 로그 목록 컨테이너 DOM 참조 |
| `toggleTabEl` | `HTMLElement` | 재오픈 탭 DOM 참조 |
| `isPanelVisible` | `boolean` | 패널 표시 여부 (초기값 `true`) |
| `isMinimized` | `boolean` | 최소화 여부 (초기값 `false`) |

**로그 항목 구조**:
```javascript
{ id, nickname, reason, time, source, timestamp }
```

---

## 4. 모듈별 기능 상세

### 섹션 1 — 데이터 레이어: [recordBan(nickname, reason, time, source)](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#54-93)
**라인 63–92**

채금 내역을 `banLogs[]`에 저장하는 **유일한 진입점**. UI 상태와 완전히 독립적으로 동작합니다.

```
호출
 ├── banLogs.unshift(entry)       ← 마스터 배열에 저장 (항상 실행)
 ├── stats 업데이트               ← 항상 실행
 ├── console.log 누적 건수 출력
 ├── if (panelEl && isPanelVisible)
 │     ├── appendLogItem(entry)   ← 패널 열려있을 때만 DOM 즉시 반영
 │     └── updateStats()
 └── updateToggleTabBadge()       ← 탭 뱃지는 항상 갱신
```

**사유 분류 정규식**:
- 도배: `/도배|반복/i` → `stats.spam++`
- 욕설: `/욕설|비방|혐오/i` → `stats.abuse++`
- 기타: 그 외 → `stats.etc++`

---

### 섹션 2 — 유틸리티 함수
**라인 94–133**

| 함수 | 역할 |
|------|------|
| [nowTime()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#98-99) | 현재 시각 `HH:MM:SS` 반환 (한국 시간, 24시간제) |
| [escapeHtml(str)](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#100-105) | `&`, `<`, `>` → HTML 엔티티 변환 (XSS 방지) |
| [bufferToDebugString(buffer)](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#106-117) | `ArrayBuffer/Uint8Array` → `"HEX: ... \| TEXT: ..."` |
| [parseWsPacket(raw)](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#118-130) | WebSocket 메시지 파싱 (문자열/바이너리 분기) |
| [isBanPacket()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#131-133) | **(Phase 2 자리표시자)** 항상 `false` |
| [parseBanPacket()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#133-134) | **(Phase 2 자리표시자)** `{ nickname: '???', reason: '???' }` |

#### [parseWsPacket](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#118-130) 파싱 로직

```
문자열 → \x00(null byte) split → { type: 'text', raw, fields[] }
ArrayBuffer → DataView로 Byte 2~3 읽기 (빅엔디안 packetType)
              → { type: 'binary', packetType, debug }
그 외 → { type: 'unknown', raw }
```

---

### 섹션 3 — WebSocket 후킹: [hookWebSocket()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#139-166)
**라인 135–165**

```
window.WebSocket → HookedWebSocket (class extends 방식)
```

- **passive 후킹**: 원본 동작을 절대 방해하지 않음
- 모든 `new WebSocket(url)` 호출을 가로채서 이벤트 리스너 주입

| 이벤트 | 동작 |
|--------|------|
| `message` | [parseWsPacket()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#118-130) → `console.log` → [isBanPacket()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#131-133) 체크 → [recordBan()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#54-93) |
| [open](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#175-179) | 연결 성공 로그 |
| [close](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#517-525) | 종료 코드 로그 |
| `error` | 에러 경고 |

##### SOOP 라이브 채팅 패킷 추정 구조

| 바이트 | 내용 |
|--------|------|
| 0~1 | 전체 길이 |
| 2~3 | 서비스 타입 |
| 4~5 | **패킷 타입** (채금 구별 예정) |
| 6~ | 바디 (`\t` 탭 구분자) |

---

### 섹션 4 — XHR 후킹: [hookXHR()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#171-218)
**라인 167–217**

```
XMLHttpRequest.prototype.open / send → 프로토타입 직접 오버라이드
```

- [open()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#175-179): 요청 URL을 `this._scannerUrl`에 저장
- [send()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#180-215): URL 필터 통과 시 `load` 이벤트에 파서 주입

**URL 필터**: `/chat|ChatLoad|BanList|fanticket/i`

**`load` 이벤트 처리 흐름**:
```
응답 수신
 └── DOMParser로 XML 파싱 (text/xml)
      └── <chat> 태그 전체 순회
           └── <c> 또는 <mt> 값이 '0'이 아닌 경우
                └── console.warn('[비정상 채팅 감지]', {
                      c, mt,
                      nick(<n>), msg(<m>), user(<u>), time(<t>),
                      raw(outerHTML)
                    })
```

> [!NOTE]
> `<c>`와 `<mt>`가 모두 `'0'`이면 정상 채팅으로 간주·무시합니다.  
> Phase 2에서 비정상 항목이 실제 채금인지 검증 후 [recordBan()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#54-93) 호출로 연결할 예정입니다.

파싱 실패 시: `console.log`로 원문 텍스트 출력 (폴백)

---

### 섹션 5 — Fetch 후킹: [hookFetch()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#223-243)
**라인 219–242**

```
window.fetch → async Proxy 함수
```

- `response.clone()`으로 body stream 복사 후 읽기
- JSON 파싱 성공 → `console.log([Fetch 수신])`
- JSON 파싱 실패 → 텍스트로 재시도 → `console.log([Fetch 텍스트])`
- 원본 `response` 객체 반드시 반환 (페이지 동작 보호)

---

### 섹션 6 — 스타일 주입: [injectStyles()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#248-378)
**라인 244–377**

`<style id="soop-ban-scanner-style">`를 `document.head`에 삽입합니다.

**주요 CSS 구성**:

| 선택자 | 역할 |
|--------|------|
| `#soop-ban-panel` | 패널 루트 (fixed, z-index 최대, 페이드 transition) |
| `#soop-ban-panel.hidden` | opacity:0 + pointer-events:none + translateY(-8px) |
| `.s-header` | 헤더 (cursor:move, 드래그 핸들) |
| `.s-stats` | 통계 바 (4열 flex) |
| `.s-body` | 로그 목록 (max-height:260px, 커스텀 스크롤바) |
| `.log-item` | 로그 행 (`ssFadeIn` 0.25s 애니메이션) |
| `#soop-ban-tab` | 재오픈 탭 (화면 우측 고정, writing-mode:vertical-rl) |
| `#soop-ban-tab.tab-hidden` | display:none |
| `.tab-badge` | 누적 건수 뱃지 (writing-mode:horizontal-tb) |

---

### 섹션 7 — 패널 생성: [createPanel()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#383-447)
**라인 379–446**

패널 HTML 구조:
```
#soop-ban-panel
  ├── .s-header  (드래그 핸들, 최소화/닫기 버튼)
  ├── .s-stats   (총 채금 / 도배 / 욕설 / 기타)
  ├── .s-body    (로그 목록 스크롤 영역)
  └── .s-footer  (후킹 활성 표시, 로그 지우기)

#soop-ban-tab    (재오픈 탭, 초기 숨김)
```

**이벤트 바인딩**:
- `#soop-ban-minimize` → [toggleMinimize()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#537-545)
- `#soop-ban-close` → [closePanel()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#517-525)
- `#soop-ban-clear` → [clearLogs()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#546-553)
- `#soop-ban-tab` → [openPanel()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#526-535)
- 헤더 → [makeDraggable()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#558-578)

패널 생성 시점에 `banLogs.length > 0`이면 즉시 [renderAllLogs()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#482-497) 호출 (후킹 중 먼저 쌓인 내역 복원).

---

### 섹션 8 — 렌더링 함수
**라인 448–511**

| 함수 | 역할 |
|------|------|
| [appendLogItem(entry)](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#452-481) | 단일 항목을 목록 맨 위(`insertBefore`)에 추가. DOM 최대 100개 유지 |
| [renderAllLogs()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#482-497) | `logListEl` 초기화 후 `banLogs[]` 전체 순회 → [appendLogItem()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#452-481) |
| [updateStats()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#498-506) | `stat-total/spam/abuse/etc` DOM 텍스트 갱신 |
| [updateToggleTabBadge()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#507-512) | `#soop-tab-badge` 텍스트를 `stats.total`로 갱신 |

**채금 사유별 색상**:

| 사유 | 색상 |
|------|------|
| 도배 / 반복 | 주황 `#e09a20` |
| 욕설 / 비방 / 혐오 | 보라 `#9c64f5` / `#7c4dff` |
| 기타 | 빨강 `#e05c5c` |

---

### 섹션 9 — 패널 열기/닫기/최소화
**라인 513–552**

#### [closePanel()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#517-525)
```
isPanelVisible = false
panelEl.classList.add('hidden')       → CSS transition으로 부드럽게 숨김
toggleTabEl.classList.remove('tab-hidden')  → 재오픈 탭 표시
updateToggleTabBadge()
```
> **데이터 수집은 계속됩니다.** [recordBan()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#54-93)은 `isPanelVisible` 무관하게 `banLogs[]` 누적.

#### [openPanel()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#526-535)
```
isPanelVisible = true
panelEl.classList.remove('hidden')
toggleTabEl.classList.add('tab-hidden')
renderAllLogs()   ← ★ 닫혀있던 동안 쌓인 전체 내역 일괄 복원
updateStats()
```

#### [toggleMinimize()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#537-545)
```
`.s-body`, `.s-stats`, `.s-footer` 의 display 토글 (none ↔ '')
버튼 텍스트: '_' ↔ '□'
```

#### [clearLogs()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#546-553)
```
banLogs.length = 0
stats.total = spam = abuse = etc = 0
logListEl.innerHTML = '<div class="s-empty">...'
updateStats() + updateToggleTabBadge()
```

---

### 섹션 10 — 드래그 이동: [makeDraggable(target, handle)](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#558-578)
**라인 554–577**

헤더(`mousedown`) → `mousemove`로 `left/top` 갱신 → `mouseup`으로 이벤트 해제.  
드래그 시작 시 `right: auto`로 설정하여 `right: 16px` 기본값 무력화.

---

### 섹션 11 — 더미 테스트: [runDummyTest()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#583-591)
**라인 579–590**

스크립트 로드 **3초 후** 가짜 채금 3건 삽입 → UI 동작 검증용.

```javascript
recordBan('테스트유저',  '도배',      '15:30:22', 'LIVE');
recordBan('닉네임예시2', '욕설/비방', '15:31:05', 'LIVE');
recordBan('닉네임예시3', '기타 사유', '15:31:58', 'VOD');
```

> [!WARNING]
> Phase 2 실제 파서 완성 후 이 블록을 제거 또는 주석 처리해야 합니다.

---

### 섹션 12 — 초기화: [init()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#596-616)
**라인 592–615**

```
init()
 ├── hookWebSocket()    ← document-start에서 즉시 실행 (DOM 불필요)
 ├── hookXHR()          ← 동일
 ├── hookFetch()        ← 동일
 └── buildUI() 예약
      ├── (loading 상태)  → DOMContentLoaded 이후 실행
      └── (이미 준비됨)   → 즉시 실행
           ├── injectStyles()
           ├── createPanel()
           └── runDummyTest()  (3초 딜레이)
```

---

## 5. 전체 데이터 흐름

```
SOOP 서버
 │
 ├─ WebSocket (라이브)
 │   └─▶ HookedWebSocket.message
 │         └─▶ parseWsPacket()
 │               └─▶ isBanPacket() [Phase 2 구현 예정]
 │                     └─▶ recordBan() → banLogs[] 누적
 │
 ├─ XHR (VOD XML)
 │   └─▶ XMLHttpRequest.send() 후킹
 │         └─▶ DOMParser → <chat> 순회
 │               └─▶ c/mt ≠ '0' → console.warn
 │                    [Phase 2: recordBan() 연결 예정]
 │
 └─ Fetch (VOD JSON)
     └─▶ window.fetch 후킹
           └─▶ response.clone().json() → console.log
                [Phase 2: recordBan() 연결 예정]
                        │
                        ▼
                  banLogs[] 마스터 배열
                        │
              ┌─────────┴─────────┐
        패널 열림                닫힘
     appendLogItem()       데이터만 누적
     updateStats()         updateToggleTabBadge()
                                  │
                           나중에 openPanel()
                           └─▶ renderAllLogs()
                               (전체 복원)
```

---

## 6. 메모리 관리

| 대상 | 정책 |
|------|------|
| `banLogs[]` | 제한 없이 누적 (세션 전체 보존) |
| DOM 로그 목록 | 최대 **100개** 유지 (초과 시 오래된 것 제거) |
| 전체 초기화 | "로그 지우기" 버튼 → `banLogs`, `stats` 모두 리셋 |

---

## 7. 보안 설계

- **XSS 방지**: 닉네임/사유/시각 등 모든 외부 데이터는 [escapeHtml()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#100-105) 통과 후 DOM 삽입
- **Passive 후킹**: WebSocket/XHR/Fetch 원본 동작을 차단하거나 수정하지 않음
- **IIFE 격리**: [(function() { 'use strict'; ... })()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#499-500) 패턴으로 전역 스코프 오염 방지
- **`@grant none`**: 브라우저 확장 특권 없이 순수 컨텐츠 스크립트로 동작

---

## 8. Phase 2 로드맵

- [ ] 콘솔 `[WS 수신]` 로그 분석 → 채금 패킷 타입 번호 확인
- [ ] [isBanPacket(parsed)](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#131-133) 구현 → 타입 번호 기반 필터
- [ ] [parseBanPacket(parsed)](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#133-134) 구현 → 닉네임/사유 필드 추출
- [ ] XHR `<c>` / `<mt>` 값 의미 확인 → [recordBan()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#54-93) 연결
- [ ] Fetch 응답 파서 구현 → [recordBan()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#54-93) 연결
- [ ] [runDummyTest()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#583-591) 제거
