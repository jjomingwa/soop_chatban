# 시스템 리서치 보고서

분석 대상: `soop-sidebar-example.js` (SOOP 사이드바 UI 변경 커스텀 스크립트)

## 1. 시스템 구조 및 동작 원리
이 스크립트는 SOOP(아프리카TV) 웹 버전을 위한 대규모 Tampermonkey UserScript로, 주로 데이터 차단, 커스텀 UI 주입, 비디오 플레이어 기능 확장 및 VOD/라이브 채팅 편의성을 목적으로 동작합니다.

**핵심 동작 방식:**
1.  **GM (Greasemonkey) API 활용:** `GM_getValue`, `GM_setValue`를 이용해 방대한 유저 설정(차단 단어, 화질 고정, 사이드바 레이아웃 등)을 로컬 스토리지처럼 동기화하여 관리하고, 크로스 오리진 요청을 위해 `GM_xmlhttpRequest`를 사용합니다.
2.  **데이터 콜렉팅 및 렌더링 독립 접근:** SOOP 내부 API(예: `sch.sooplive.com/api.php`, `broadstatistic.sooplive.com`)를 백그라운드에서 직접 호출하여 데이터를 가져오고, 리캡(Recap), 외부 채널 뷰 등의 자체 UI 컨테이너를 직접 주입(Inject)하여 렌더링합니다.
3.  **적극적인 DOM 관찰(Observer Pattern):** `MutationObserver`를 래핑한 `safeMutationObserver`를 다수 활용합니다. 특히 채팅 컨테이너가 렌더링되는 시점을 감시하며, 채팅 메시지 노드가 생성될 때마다 내용(`setWidthNickname`, `checkMessageForBlocking`)을 검사하여 숨김/스타일 변경 처리를 동기적으로 수행합니다.
4.  **네트워크 후킹(Hooking) 미사용:** WebSocket이나 XMLHttpRequest 프로토타입 자체를 가로채지(Hooking) 않고 오로지 DOM 레이어 단의 변경을 감지하거나 고유한 API 요청을 발행하는 것에 의존합니다.

## 2. 주요 함수 및 레이어 관계
**구조적 레이어 분류:**
*   **설정 및 상태 레이어 (Configuration Layer):**
    *   스크립트 상단의 약 100여 개 상수/변수 선언 및 `GM_getValue` 바인딩(`isCustomSidebarEnabled`, `registeredWords`, `isVODChatScanEnabled` 등).
*   **유틸리티 및 데이터 통신 레이어 (Utility & Fetch Layer):**
    *   `runCommonFunctions`, `getSharedTabSyncManager`: 다른 탭과의 동기화를 관리하며, 이벤트 브로드캐스팅 수행.
*   **UI 주입 및 DOM 핸들링 레이어 (UI Injection & DOM Manipulation):**
    *   `createIcon`, `insertRemainingBuffer`: 새로운 버튼이나 시간 텍스트를 플레이어 근처 DOM에 주입.
    *   `initPanzoom`, `initAdvControlsForVOD`: 화질 저하 방지 모니터, 플레이어 제어(P&Z) 패널 등 복잡한 마크업 생성.
*   **채팅 관찰 레이어 (Chat Observation Layer):**
    *   `observeChatForBlockingWords`: 내부에서 `.chatting-list-item` 메시지 요소를 확인하고 필터링 로직(`compileBlockRules`, `checkMessageForBlocking`)과 연계하여 `display: none` 등의 처리를 수행. 정규식과 Set 객체를 혼합하여 성능을 최적화.

**기존 레이어와의 상호작용 및 API 중복성:**
*   ORM 관리 체계는 가지지 않으며 전적으로 `GM` 스토리지 API 기반 캐싱을 활용.
*   우리의 `soop-ban-scanner.js`는 WebSocket 데이터 콜렉팅 계층에 개입하는 반면, 이 스크립트는 **DOM 렌더링 이후**의 결과물에 집중합니다. 데이터 소스는 분리되어 있어 네트워크 로직 중복 위험은 적습니다.

## 3. 잠재적 위험 요소 (사이드 이펙트)
`soop-ban-scanner.js`와 이 확장 프로그램을 동시에 활성화할 경우 다음 부분에서 직접적인 충돌이 발생할 수 있습니다.

1.  **채팅 DOM 직접수정 충돌 (가장 심각한 이슈):**
    *   해당 스크립트는 `.chatting-list-item` 요소에 대해 닉네임 길이를 강제 제한(`setWidthNickname`)하거나 불필요한 배지 제거(`hideBadges`), 차단 단어 포함 시 아예 요소를 안 보이게(`display: none`) 처리합니다.
    *   **Side Effect:** 우리의 채팅 스캐너가 추가한 커스텀 아이콘(`.chat-icon-trigger`)이 CSS 덮어쓰기나 DOM 재생성(리플로우)으로 인해 보이지 않게 되거나, 요소 접근 순서 차이로 아이콘 위치가 깨질(#1, #2 버튼 순서 변경) 위험이 높습니다.
2.  **스타일(CSS) 네임스페이스 및 레이아웃 간섭:**
    *   임의의 `.customSidebar`, `.left_navbar` 스타일이 SOOP의 최상위 컨테이너 레이아웃을 조작합니다. 채팅창 너비 조작이나 VOD 채팅 영역 확장(`isExpandVODChatAreaEnabled`)이 기능에 켜져 있을 경우 우리가 계산한 `translateY` 등의 고정 픽셀(px) 오프셋이 어긋날 수 있습니다.
3.  **과도한 Observer 점유로 인한 성능 트러블:**
    *   채팅 노드 삽입 시마다 각각 자체적인 DOM 검사 로직(하나는 정규식 텍스트 검사, 하나는 밴 기록 검사+버튼 주입)이 연달아 발생합니다. 라이브 방송의 채팅 속도가 빨라지면 무거운 Reflow가 두 배로 발생하며 브라우저 멈춤 또는 동기화 오류를 유발할 수 있습니다.
4.  **해결 및 방어 대책 (권장):**
    *   우리 스캐너의 Trigger 아이콘 주입 시, 부모 `.chatting-list-item`에 고유 클래스(`data-ban-scanned="true"`) 마커를 찍어 중복 주입을 방어하고, CSS `!important`를 활용하여 크기와 위치를 강제.
    *   `MutationObserver` 사용 시 가능한 낮은 Depth에서 관찰을 시작하고 필터링 최적화를 반영해야 함.
