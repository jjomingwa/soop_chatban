# Plan: 채금 스캐너 아이콘 트리거 구현

## 목표
패널을 처음부터 표시하는 대신, SOOP 채팅 UI의 하트 아이콘 **위**에 작은 채금 스캐너 아이콘을 삽입하고 클릭 시 패널 토글

## 확인된 DOM 구조

```
#chatbox
  └── div.chatting-item-wrap
        ├── div.chat-icon.highlight-icon.highlight   ← 하트 (기존)
        └── div.chat-icon.trash-icon.trash           ← 쓰레기통 (타 확장)
```

**삽입 위치**: 하트(`.highlight-icon`) 바로 앞에 `insertBefore`

---

## 변경 사항

### 1. `isPanelVisible` 초기값 변경
패널이 처음엔 숨겨진 상태로 시작

```js
// 기존
let isPanelVisible = true;

// 변경
let isPanelVisible = false;
```

---

### 2. [createPanel()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#383-447) 수정 — 처음부터 hidden으로 생성

```js
const createPanel = () => {
    panelEl = document.createElement('div');
    panelEl.id = 'soop-ban-panel';
    panelEl.classList.add('hidden');  // ← 추가: 처음엔 숨김
    panelEl.innerHTML = `...`;
    // ... 나머지 동일
};
```

---

### 3. `injectTriggerIcon()` 함수 신규 추가

트리거 아이콘을 하트 위에 삽입합니다.  
`#chatbox`가 아직 없을 수 있으므로 `MutationObserver`로 대기합니다.

```js
const injectTriggerIcon = () => {
    const CONTAINER_SEL = '#chatbox > div.chatting-item-wrap';
    const HEART_SEL     = 'div.chat-icon.highlight-icon.highlight';
    const ICON_ID       = 'soop-ban-trigger-icon';

    const doInject = () => {
        // 이미 삽입된 경우 중복 방지
        if (document.getElementById(ICON_ID)) return;

        const container = document.querySelector(CONTAINER_SEL);
        if (!container) return;

        const heartEl = container.querySelector(HEART_SEL);
        if (!heartEl) return;

        // 아이콘 요소 생성 (기존 chat-icon 패턴과 동일한 구조)
        const icon = document.createElement('div');
        icon.id = ICON_ID;
        icon.className = 'chat-icon soop-ban-icon';
        icon.title = '채금 스캐너 열기/닫기';
        icon.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
               width="20" height="20" fill="currentColor">
            <!-- 🚫 금지 아이콘 -->
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10
                     10-4.48 10-10S17.52 2 12 2zm-1 15v-4H7l5-8v4h4l-5 8z"/>
          </svg>
        `;

        // 하트 아이콘 바로 앞에 삽입
        container.insertBefore(icon, heartEl);

        // 클릭 시 패널 토글
        icon.addEventListener('click', () => {
            if (isPanelVisible) {
                closePanel();
            } else {
                openPanel();
            }
        });

        console.log('[채금스캐너] 트리거 아이콘 삽입 완료');
    };

    // DOM이 이미 있으면 즉시 삽입 시도
    doInject();

    // SPA 특성상 chatbox가 나중에 생성될 수 있으므로 MutationObserver로 대기
    if (!document.getElementById(ICON_ID)) {
        const observer = new MutationObserver(() => {
            doInject();
            if (document.getElementById(ICON_ID)) {
                observer.disconnect(); // 삽입 성공 시 감시 종료
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }
};
```

---

### 4. [injectStyles()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#248-378) — 아이콘 CSS 추가

기존 `.chat-icon` 스타일에 맞게 추가 (별도 블록으로 추가)

```css
/* 채금 스캐너 트리거 아이콘 */
.soop-ban-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  cursor: pointer;
  color: #aaa;
  transition: color 0.2s, background 0.2s;
  margin-bottom: 4px;
}
.soop-ban-icon:hover {
  color: #e05c5c;
  background: rgba(224, 92, 92, 0.12);
}
/* 패널이 열려있을 때 강조 */
.soop-ban-icon.active {
  color: #e05c5c;
}
```

---

### 5. [closePanel()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#517-525) / [openPanel()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#526-535) 수정 — 아이콘 active 상태 연동

```js
const closePanel = () => {
    isPanelVisible = false;
    panelEl.classList.add('hidden');
    document.getElementById('soop-ban-trigger-icon')?.classList.remove('active'); // ← 추가
    toggleTabEl?.classList.remove('tab-hidden'); // 재오픈 탭은 제거 가능 (아이콘으로 대체)
    console.log('[채금스캐너] 패널 숨김.');
};

const openPanel = () => {
    isPanelVisible = true;
    panelEl.classList.remove('hidden');
    document.getElementById('soop-ban-trigger-icon')?.classList.add('active');    // ← 추가
    toggleTabEl?.classList.add('tab-hidden');
    renderAllLogs();
    updateStats();
    console.log('[채금스캐너] 패널 열림.');
};
```

---

### 6. [init()](file:///c:/Users/dabin/CodingWorkSpace/soop_chatban/soop-ban-scanner.js#596-616) — `injectTriggerIcon()` 호출 추가

```js
const buildUI = () => {
    injectStyles();
    createPanel();
    injectTriggerIcon();  // ← 추가
    runDummyTest();
};
```

---

### 7. 재오픈 탭 (`#soop-ban-tab`) 처리
트리거 아이콘이 역할을 대신하므로 재오픈 탭은 **제거하거나 뱃지 역할만 유지**.  
`toggleTabEl` 관련 코드를 삭제하거나 `display:none` 처리.

---

## 최종 UX 흐름

```
페이지 로딩
    └── injectTriggerIcon()
          └── MutationObserver 대기
                └── #chatbox.chatting-item-wrap 생성 감지
                      └── 하트 아이콘 위에 🚫 아이콘 삽입

사용자가 아이콘 클릭
    ├── 패널 닫힌 상태 → openPanel() → 패널 표시 + 아이콘 빨간색
    └── 패널 열린 상태 → closePanel() → 패널 숨김 + 아이콘 회색
```

## 주의사항
- SOOP은 SPA(Vue 기반)로, pageload 후 chatbox DOM이 늦게 생성될 수 있음 → MutationObserver 필수
- 방송 전환 시 chatbox가 재생성될 수 있으므로 `ICON_ID` 중복 체크 필수
- `.chat-icon` 클래스의 실제 크기/여백은 SOOP 업데이트에 따라 달라질 수 있음
