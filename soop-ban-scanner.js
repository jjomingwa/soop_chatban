// ==UserScript==
// @name         SOOP 채금 스캐너
// @namespace    https://github.com/your-namespace/soop-ban-scanner
// @version      0.2.0
// @description  SOOP 라이브/VOD 채금 내역을 실시간 감지 및 누적 표시. 패널을 닫아도 내역은 계속 쌓입니다.
// @author       your-name
// @match        https://play.sooplive.com/*
// @match        https://vod.sooplive.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/**
 * ════════════════════════════════════════════════════════════════
 *  SOOP 채금 스캐너 v0.2.0
 *  ★ 핵심 변경: 데이터 수집 ↔ UI 렌더링 완전 분리
 *
 *  [데이터 레이어]  banLogs[]  ← 패널 열림/닫힘과 무관하게 항상 누적
 *  [UI 레이어]      패널 DOM  ← banLogs[]를 읽어서 표시만 함
 *                              패널을 열 때 전체 내역을 일괄 렌더링
 * ════════════════════════════════════════════════════════════════
 */

; (function () {
    'use strict';

    // ──────────────────────────────────────────────────────────────
    //  0. 전역 데이터 저장소 (UI와 완전히 독립)
    // ──────────────────────────────────────────────────────────────

    /**
     * 채금 로그 마스터 배열.
     * 패널이 숨겨져 있거나 아직 생성되지 않아도 여기에 계속 추가됩니다.
     * 각 항목: { id, nickname, reason, time, source, timestamp }
     */
    const banLogs = [];

    /** 자동 증가 ID (로그 항목 식별용) */
    let logIdCounter = 0;

    /** 통계 카운터 */
    const stats = { total: 0, spam: 0, abuse: 0, etc: 0 };

    /** 유저별 최근 채팅 캐시 (최대 10개) */
    const USER_CHAT_MEMORY = {};
    const trackUserChat = (nickname, message, time) => {
        if (!nickname || !message) return;
        if (!USER_CHAT_MEMORY[nickname]) USER_CHAT_MEMORY[nickname] = [];
        USER_CHAT_MEMORY[nickname].push({ time, message });
        if (USER_CHAT_MEMORY[nickname].length > 10) USER_CHAT_MEMORY[nickname].shift();
    };

    /** 패널 DOM 참조 */
    let panelEl = null;
    let logListEl = null;
    let isPanelVisible = false;

    // ──────────────────────────────────────────────────────────────
    //  1. 데이터 레이어 — 채금 로그 추가 (UI 와 무관)
    // ──────────────────────────────────────────────────────────────

    /**
     * 채금 내역을 마스터 배열(banLogs)에 저장합니다.
     * 패널 표시 여부와 상관없이 항상 실행됩니다.
     *
     * @param {string} nickname  채금당한 닉네임
     * @param {string} reason    채금 사유
     * @param {string} time      발생 시각 문자열
     * @param {string} [source]  'LIVE' 또는 'VOD'
     */
    const recordBan = (nickname, reason, time, source = 'LIVE', messages = []) => {
        const entry = {
            id: ++logIdCounter,
            nickname,
            reason,
            time,
            source,
            messages, // 해당 유저의 채팅 히스토리
            timestamp: Date.now(),
        };

        // 마스터 배열 앞에 추가 (최신 순)
        banLogs.unshift(entry);

        // 통계 업데이트
        stats.total++;
        if (/도배|반복/i.test(reason)) stats.spam++;
        else if (/욕설|비방|혐오/i.test(reason)) stats.abuse++;
        else stats.etc++;

        console.log(`[채금스캐너] 누적: ${nickname} / ${reason} / ${time} [${source}] (총 ${stats.total}건)`);

        // 패널이 열려있을 때만 즉시 DOM 업데이트
        // 닫혀있으면 열 때 renderAllLogs()가 전체를 다시 그림
        if (panelEl && isPanelVisible) {
            appendLogItem(entry);
            updateStats();
        }
    };

    // ──────────────────────────────────────────────────────────────
    //  2. 유틸리티
    // ──────────────────────────────────────────────────────────────

    const nowTime = () => new Date().toLocaleTimeString('ko-KR', { hour12: false });

    const escapeHtml = (str) =>
        String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

    const bufferToDebugString = (buffer) => {
        try {
            const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
            const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
            const text = new TextDecoder('utf-8', { fatal: false })
                .decode(bytes).replace(/[\x00-\x1F]/g, '.');
            return `HEX: ${hex} | TEXT: ${text}`;
        } catch (e) {
            return `(버퍼 변환 실패: ${e.message})`;
        }
    };

    const parseWsPacket = (raw) => {
        if (typeof raw === 'string') {
            const fields = raw.split('\x00').filter(Boolean);
            return { type: 'text', raw, fields };
        }
        if (raw instanceof ArrayBuffer) {
            const view = new DataView(raw);
            const packetType = raw.byteLength >= 4 ? view.getUint16(2, false) : null;
            return { type: 'binary', packetType, debug: bufferToDebugString(raw) };
        }
        return { type: 'unknown', raw: String(raw) };
    };

    // Phase 2 자리표시자
    const isBanPacket = (/* parsed */) => false;
    const parseBanPacket = (/* parsed */) => ({ nickname: '???', reason: '???' });

    // ──────────────────────────────────────────────────────────────
    //  3. 통신 후킹 — WebSocket (라이브)
    // ──────────────────────────────────────────────────────────────

    const hookWebSocket = () => {
        const OriginalWebSocket = window.WebSocket;

        class HookedWebSocket extends OriginalWebSocket {
            constructor(url, protocols) {
                super(url, protocols);
                console.log(`[채금스캐너][WS] 연결: ${url}`);

                this.addEventListener('message', (event) => {
                    const parsed = parseWsPacket(event.data);
                    console.log('[채금스캐너][WS 수신]', parsed);

                    if (isBanPacket(parsed)) {
                        const { nickname, reason } = parseBanPacket(parsed);
                        recordBan(nickname, reason, nowTime(), 'LIVE');
                    }
                });

                this.addEventListener('open', () => console.log(`[채금스캐너][WS] 연결 성공: ${url}`));
                this.addEventListener('close', (e) => console.log(`[채금스캐너][WS] 종료: code=${e.code}`));
                this.addEventListener('error', (e) => console.warn('[채금스캐너][WS] 에러:', e));
            }
        }

        window.WebSocket = HookedWebSocket;
        console.log('[채금스캐너] WebSocket 후킹 완료');
    };

    // ──────────────────────────────────────────────────────────────
    //  4. 통신 후킹 — XHR & Fetch (VOD 공통 파서)
    // ──────────────────────────────────────────────────────────────

    const parseVodChatXml = (xmlText) => {
        try {
            const parser = new DOMParser();
            const xml = parser.parseFromString(xmlText, 'text/xml');
            const chats = xml.querySelectorAll('chat');

            chats.forEach(chat => {
                const c = chat.querySelector('c')?.textContent || '0';
                const mt = chat.querySelector('mt')?.textContent || '0';
                const nick = chat.querySelector('n')?.textContent;
                const msg = chat.querySelector('m')?.textContent;
                const time = chat.querySelector('t')?.textContent || nowTime();

                if (c === '0' && mt === '0') {
                    trackUserChat(nick, msg, time);
                } else {
                    const memory = USER_CHAT_MEMORY[nick] ? [...USER_CHAT_MEMORY[nick]] : [];
                    if (msg && msg.trim().length > 0) memory.push({ time, message: msg });

                    const reasonTag = `시스템 감지 [${c}/${mt}]`;
                    recordBan(nick || '시스템/알수없음', reasonTag, time, 'VOD', memory);

                    console.warn('[채금스캐너][비정상 채팅 감지]', {
                        c, mt, nick, msg, time, raw: chat.outerHTML
                    });
                }
            });
        } catch {
            // 파싱 실패 또는 XML 포맷이 아님
        }
    };

    const hookXHR = () => {
        const OriginalOpen = XMLHttpRequest.prototype.open;
        const OriginalSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            this._scannerUrl = url;
            return OriginalOpen.apply(this, [method, url, ...rest]);
        };

        XMLHttpRequest.prototype.send = function (body) {
            const url = this._scannerUrl || '';
            const isChatUrl = /chat|ChatLoad|BanList|fanticket/i.test(url);

            if (isChatUrl) {
                this.addEventListener('load', () => {
                    parseVodChatXml(this.responseText);
                });
            }

            return OriginalSend.apply(this, [body]);
        };

        console.log('[채금스캐너] XHR 후킹 완료');
    };

    // ──────────────────────────────────────────────────────────────
    //  5. 통신 후킹 — Fetch
    // ──────────────────────────────────────────────────────────────

    const hookFetch = () => {
        const originalFetch = window.fetch;

        window.fetch = async function (input, init) {
            const url = typeof input === 'string' ? input : input?.url || '';
            const isChatUrl = /chat|ChatLoad|BanList|fanticket/i.test(url);
            
            const response = await originalFetch.apply(this, [input, init]);

            if (isChatUrl) {
                response.clone().text().then(text => {
                    parseVodChatXml(text);
                }).catch(() => { });
            }

            return response;
        };

        console.log('[채금스캐너] Fetch 후킹 완료');
    };

    // ──────────────────────────────────────────────────────────────
    //  6. UI — 스타일
    // ──────────────────────────────────────────────────────────────

    const injectStyles = () => {
        const style = document.createElement('style');
        style.id = 'soop-ban-scanner-style';
        style.textContent = `
      #soop-ban-panel {
        position: fixed; top: 16px; right: 16px; width: 320px;
        z-index: 2147483647;
        font-family: 'Malgun Gothic','Apple SD Gothic Neo',sans-serif;
        font-size: 13px; border-radius: 8px; overflow: hidden;
        box-shadow: 0 4px 24px rgba(0,0,0,0.6); border: 1px solid #2e333d;
        transition: opacity 0.2s, transform 0.2s;
      }
      #soop-ban-panel.hidden {
        opacity: 0; pointer-events: none; transform: translateY(-8px);
      }
      #soop-ban-panel .s-header {
        background: #13161b; display: flex; align-items: center;
        justify-content: space-between; padding: 8px 12px;
        border-bottom: 1px solid #2e333d; cursor: move;
      }
      #soop-ban-panel .s-title {
        font-size: 13px; font-weight: 700; color: #e8eaf0;
        display: flex; align-items: center; gap: 6px;
      }
      #soop-ban-panel .badge-live {
        background: #c0392b; color: #fff; font-size: 10px;
        font-weight: 700; padding: 2px 6px; border-radius: 4px;
      }
      #soop-ban-panel .s-btns { display: flex; gap: 5px; }
      #soop-ban-panel .s-btn {
        background: none; border: 1px solid #3a3f4b; border-radius: 4px;
        color: #888; font-size: 12px; cursor: pointer; padding: 2px 7px;
        transition: background 0.15s;
      }
      #soop-ban-panel .s-btn:hover { background: #2e333d; color: #ccc; }
      #soop-ban-panel .s-stats {
        display: flex; background: #13161b; border-bottom: 1px solid #2e333d;
      }
      #soop-ban-panel .stat-cell {
        flex: 1; text-align: center; padding: 7px 0;
        border-right: 1px solid #2e333d;
      }
      #soop-ban-panel .stat-cell:last-child { border-right: none; }
      #soop-ban-panel .stat-num {
        font-size: 18px; font-weight: 700; color: #e05c5c; line-height: 1.2;
      }
      #soop-ban-panel .stat-label { font-size: 10px; color: #666; margin-top: 2px; }
      #soop-ban-panel .s-body {
        background: #1a1d23; max-height: 260px; overflow-y: auto;
        scrollbar-width: thin; scrollbar-color: #3a3f4b #1a1d23;
      }
      #soop-ban-panel .s-body::-webkit-scrollbar { width: 5px; }
      #soop-ban-panel .s-body::-webkit-scrollbar-track { background: #1a1d23; }
      #soop-ban-panel .s-body::-webkit-scrollbar-thumb {
        background: #3a3f4b; border-radius: 3px;
      }
      #soop-ban-panel .s-empty {
        text-align: center; color: #444; font-size: 12px; padding: 32px 0;
      }
      #soop-ban-panel .log-item {
        display: flex; flex-direction: column;
        padding: 8px 12px; border-bottom: 1px solid #1e2229;
        animation: ssFadeIn 0.25s ease;
        cursor: pointer; /* 클릭 가능하도록 변경 */
      }
      #soop-ban-panel .log-wrap {
        display: flex; align-items: flex-start; gap: 8px; width: 100%;
      }
      #soop-ban-panel .log-item:last-child { border-bottom: none; }
      #soop-ban-panel .log-item:hover { background: #20242d; }
      #soop-ban-panel .log-avatar {
        width: 28px; height: 28px; border-radius: 50%; background: #2a3040;
        display: flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 700; color: #8899cc;
        flex-shrink: 0; margin-top: 1px;
      }
      #soop-ban-panel .log-main { flex: 1; min-width: 0; }
      #soop-ban-panel .log-nick {
        font-size: 12px; font-weight: 700; color: #d0d6e8;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      #soop-ban-panel .log-reason {
        font-size: 11px; color: #e05c5c; margin-top: 2px;
        display: flex; align-items: center; gap: 4px;
      }
      #soop-ban-panel .reason-dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: #e05c5c; flex-shrink: 0;
      }
      #soop-ban-panel .log-time { font-size: 10px; color: #555; margin-top: 3px; }
      
      /* 채팅 내역 펼침 UI */
      #soop-ban-panel .log-detail {
        display: none; width: 100%; margin-top: 8px; padding-top: 8px;
        border-top: 1px dashed #3a3f4b;
      }
      #soop-ban-panel .log-item.expanded .log-detail { display: block; }
      #soop-ban-panel .detail-msg {
        font-size: 11px; color: #aaa; margin-bottom: 4px; line-height: 1.3;
        word-break: break-word;
      }
      #soop-ban-panel .detail-msg span.time { color: #555; margin-right: 4px; font-size: 10px; }
      #soop-ban-panel .detail-empty { color: #555; font-size: 11px; font-style: italic; }
      #soop-ban-panel .s-footer {
        background: #13161b; padding: 6px 12px; border-top: 1px solid #2e333d;
        display: flex; justify-content: space-between; align-items: center;
      }
      #soop-ban-panel .footer-status {
        font-size: 10px; color: #555; display: flex; align-items: center; gap: 5px;
      }
      #soop-ban-panel .ws-dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: #27ae60; display: inline-block;
      }
      #soop-ban-panel .footer-clear {
        font-size: 10px; color: #555; cursor: pointer; text-decoration: underline;
      }
      #soop-ban-panel .footer-clear:hover { color: #e05c5c; }

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
        transform: translateY(-75px); /* 쓰레기통과 하트 아이콘 위로 배치 */
      }
      .soop-ban-icon:hover {
        color: #e05c5c;
        background: rgba(224, 92, 92, 0.12);
      }
      /* 패널이 열려있을 때 강조 */
      .soop-ban-icon.active {
        color: #e05c5c;
      }
      /* VOD 폴백용 강제 플로팅 스타일 */
      .soop-ban-icon.vod-fallback {
        position: fixed;
        right: 20px;
        bottom: 80px;
        background: #1e2229;
        border: 1px solid #3a3f4b;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        z-index: 2147483647;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        transform: none; /* 올려친 위치 취소 */
      }
      .soop-ban-icon.vod-fallback:hover {
        background: #2e333d;
      }

      @keyframes ssFadeIn {
        from { opacity: 0; transform: translateY(-4px); }
        to   { opacity: 1; transform: translateY(0); }
      }
    `;
        document.head.appendChild(style);
    };

    // ──────────────────────────────────────────────────────────────
    //  7. UI — 패널 생성
    // ──────────────────────────────────────────────────────────────

    const createPanel = () => {
        panelEl = document.createElement('div');
        panelEl.id = 'soop-ban-panel';
        panelEl.classList.add('hidden'); // 처음엔 숨김
        panelEl.innerHTML = `
      <div class="s-header" id="soop-ban-drag">
        <div class="s-title">
          🚨 실시간 채금 로그
          <span class="badge-live">LIVE</span>
        </div>
        <div class="s-btns">
          <button class="s-btn" id="soop-ban-minimize" title="최소화">_</button>
          <button class="s-btn" id="soop-ban-close" title="패널 숨기기 (데이터는 계속 수집)">✕</button>
        </div>
      </div>
      <div class="s-stats">
        <div class="stat-cell">
          <div class="stat-num" id="stat-total">0</div>
          <div class="stat-label">총 채금</div>
        </div>
        <div class="stat-cell">
          <div class="stat-num" id="stat-spam" style="color:#e09a20">0</div>
          <div class="stat-label">도배</div>
        </div>
        <div class="stat-cell">
          <div class="stat-num" id="stat-abuse" style="color:#7c4dff">0</div>
          <div class="stat-label">욕설</div>
        </div>
        <div class="stat-cell">
          <div class="stat-num" id="stat-etc" style="color:#888">0</div>
          <div class="stat-label">기타</div>
        </div>
      </div>
      <div class="s-body" id="soop-ban-list">
        <div class="s-empty">채금 내역이 없습니다</div>
      </div>
      <div class="s-footer">
        <span class="footer-status">
          <span class="ws-dot"></span>후킹 활성 중
        </span>
        <span class="footer-clear" id="soop-ban-clear">로그 지우기</span>
      </div>
    `;
        document.body.appendChild(panelEl);
        logListEl = document.getElementById('soop-ban-list');

        // ── 이벤트 ──
        document.getElementById('soop-ban-minimize').addEventListener('click', toggleMinimize);
        document.getElementById('soop-ban-close').addEventListener('click', closePanel);
        document.getElementById('soop-ban-clear').addEventListener('click', clearLogs);
        makeDraggable(panelEl, document.getElementById('soop-ban-drag'));

        // 패널 생성 전에 이미 쌓인 로그 있으면 즉시 렌더링
        if (banLogs.length > 0) renderAllLogs();

        console.log('[채금스캐너] UI 패널 생성 완료');
    };

    // ──────────────────────────────────────────────────────────────
    //  8. UI — 렌더링
    // ──────────────────────────────────────────────────────────────

    /** 단일 항목을 목록 맨 위에 추가 */
    const appendLogItem = (entry) => {
        const emptyEl = logListEl.querySelector('.s-empty');
        if (emptyEl) emptyEl.remove();

        let reasonColor = '#e05c5c', dotColor = '#e05c5c';
        if (/도배|반복/i.test(entry.reason)) { reasonColor = '#e09a20'; dotColor = '#e09a20'; }
        else if (/욕설|비방|혐오/i.test(entry.reason)) { reasonColor = '#9c64f5'; dotColor = '#7c4dff'; }

        const item = document.createElement('div');
        item.className = 'log-item';
        item.dataset.logId = entry.id;

        const messagesHtml = (entry.messages && entry.messages.length > 0)
            ? entry.messages.map(m => `<div class="detail-msg"><span class="time">[${m.time}]</span>${escapeHtml(m.message)}</div>`).join('')
            : '<div class="detail-empty">이전 채팅 기록이 없습니다.</div>';

        item.innerHTML = `
          <div class="log-wrap">
            <div class="log-avatar">${escapeHtml(entry.nickname.charAt(0) || '?')}</div>
            <div class="log-main">
              <div class="log-nick">${escapeHtml(entry.nickname)}</div>
              <div class="log-reason" style="color:${reasonColor}">
                <span class="reason-dot" style="background:${dotColor}"></span>
                ${escapeHtml(entry.reason)}
              </div>
              <div class="log-time">⏱ ${escapeHtml(entry.time)} · ${entry.source} (클릭하여 채팅 내역 보기)</div>
            </div>
          </div>
          <div class="log-detail">
            ${messagesHtml}
          </div>
        `;

        // 내역 펼침 이벤트 달기
        item.addEventListener('click', () => {
            item.classList.toggle('expanded');
        });

        // 리스트 상단에 삽입
        logListEl.insertBefore(item, logListEl.firstChild);

        // 최대 100개 유지
        const items = logListEl.querySelectorAll('.log-item');
        if (items.length > 100) items[items.length - 1].remove();
    };

    /**
     * ★ 핵심 함수: banLogs[] 전체를 DOM에 다시 그립니다.
     * 패널을 열 때 호출 → 닫혀있는 동안 쌓인 내역이 한번에 표시됩니다.
     */
    const renderAllLogs = () => {
        if (!logListEl) return;
        logListEl.innerHTML = '';
        if (banLogs.length === 0) {
            logListEl.innerHTML = '<div class="s-empty">채금 내역이 없습니다</div>';
            return;
        }
        // banLogs는 이미 unshift로 최신순 정렬되어 있음
        banLogs.forEach(entry => appendLogItem(entry));
        updateStats();
    };

    const updateStats = () => {
        const el = (id) => document.getElementById(id);
        if (!el('stat-total')) return;
        el('stat-total').textContent = stats.total;
        el('stat-spam').textContent = stats.spam;
        el('stat-abuse').textContent = stats.abuse;
        el('stat-etc').textContent = stats.etc;
    };

    // ──────────────────────────────────────────────────────────────
    //  9. UI — 패널 열기/닫기/최소화
    // ──────────────────────────────────────────────────────────────

    /** 패널 숨김. 데이터 수집은 계속됩니다. */
    const closePanel = () => {
        isPanelVisible = false;
        panelEl.classList.add('hidden');
        document.getElementById('soop-ban-trigger-icon')?.classList.remove('active');
        console.log('[채금스캐너] 패널 숨김. 데이터 수집은 계속됩니다.');
    };

    /** 패널 다시 열기. 닫혀있던 동안 쌓인 로그를 전부 렌더링. */
    const openPanel = () => {
        isPanelVisible = true;
        panelEl.classList.remove('hidden');
        document.getElementById('soop-ban-trigger-icon')?.classList.add('active');
        renderAllLogs(); // ← 누적된 전체 내역 일괄 표시
        updateStats();
        console.log('[채금스캐너] 패널 열림. 누적 내역 렌더링 완료.');
    };

    let isMinimized = false;
    const toggleMinimize = () => {
        isMinimized = !isMinimized;
        ['s-body', 's-stats', 's-footer'].forEach(cls => {
            const el = panelEl.querySelector('.' + cls);
            if (el) el.style.display = isMinimized ? 'none' : '';
        });
        document.getElementById('soop-ban-minimize').textContent = isMinimized ? '□' : '_';
    };

    const clearLogs = () => {
        banLogs.length = 0;
        stats.total = stats.spam = stats.abuse = stats.etc = 0;
        if (logListEl) logListEl.innerHTML = '<div class="s-empty">채금 내역이 없습니다</div>';
        updateStats();
    };

    // ──────────────────────────────────────────────────────────────
    //  10. UI — 트리거 아이콘
    // ──────────────────────────────────────────────────────────────

    const injectTriggerIcon = () => {
        const ICON_ID = 'soop-ban-trigger-icon';

        const doInject = () => {
            if (document.getElementById(ICON_ID)) return;

            // 라이브 타겟
            const liveContainer = document.querySelector('#chatbox > div.chatting-item-wrap');
            const heartEl = liveContainer ? liveContainer.querySelector('div.chat-icon.highlight-icon.highlight') : null;

            // VOD 타겟 (아프리카 VOD 채팅 컨테이너)
            const vodContainer = document.querySelector('#chat_area') || document.querySelector('.chat-area') || document.querySelector('#chatbox');

            let targetContainer = null;
            let insertBeforeEl = null;
            let isVodMode = false;

            if (liveContainer && heartEl) {
                targetContainer = liveContainer;
                insertBeforeEl = heartEl;
            } else if (window.location.hostname.includes('vod.') || vodContainer) {
                targetContainer = vodContainer || document.body;
                isVodMode = true;
            } else {
                return; // 삽입할 곳을 찾지 못함
            }

            const icon = document.createElement('div');
            icon.id = ICON_ID;
            // VOD 환경에서는 화면 우측 하단 쪽에 플로팅 버튼처럼 고정되거나 VOD 컨테이너 내부에 맞게 조정
            icon.className = isVodMode ? 'chat-icon soop-ban-icon vod-fallback' : 'chat-icon soop-ban-icon';
            icon.title = '채금 스캐너 열기/닫기';
            icon.innerHTML = `
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
                   width="20" height="20" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10
                         10-4.48 10-10S17.52 2 12 2zm-1 15v-4H7l5-8v4h4l-5 8z"/>
              </svg>
            `;

            if (isVodMode && targetContainer === document.body) {
                // 완전히 찾지 못한 경우 body에 floating
                targetContainer.appendChild(icon);
            } else if (insertBeforeEl) {
                // 라이브 환경 (하트 앞에 삽입)
                targetContainer.insertBefore(icon, insertBeforeEl);
            } else {
                // VOD 환경 (채팅 헤더나 컨테이너 우측 상단에 prepend)
                targetContainer.appendChild(icon);
            }

            icon.addEventListener('click', () => {
                if (isPanelVisible) closePanel();
                else openPanel();
            });

            console.log('[채금스캐너] 트리거 아이콘 삽입 완료 (VOD 폴백: ' + isVodMode + ')');
        };

        doInject();

        if (!document.getElementById(ICON_ID)) {
            const observer = new MutationObserver(() => {
                doInject();
                if (document.getElementById(ICON_ID)) observer.disconnect();
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }
    };
    // ──────────────────────────────────────────────────────────────
    //  11. UI — 드래그 이동
    // ──────────────────────────────────────────────────────────────

    const makeDraggable = (target, handle) => {
        let startX, startY, origLeft, origTop;
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startX = e.clientX; startY = e.clientY;
            const rect = target.getBoundingClientRect();
            origLeft = rect.left; origTop = rect.top;
            const onMove = (e) => {
                target.style.left = `${origLeft + e.clientX - startX}px`;
                target.style.top = `${origTop + e.clientY - startY}px`;
                target.style.right = 'auto';
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    };

    // ──────────────────────────────────────────────────────────────
    //  12. 더미 테스트 (Phase 1 검증용 — Phase 2 완성 후 제거)
    // ──────────────────────────────────────────────────────────────

    const runDummyTest = () => {
        setTimeout(() => {
            console.log('[채금스캐너] 더미 데이터 테스트 실행');
            recordBan('테스트유저', '도배', '15:30:22', 'LIVE', [
                { time: '15:29:10', message: 'ㅋㅋ' },
                { time: '15:29:15', message: 'ㅋㅋ' },
                { time: '15:29:20', message: 'ㅋㅋ' }
            ]);
            recordBan('닉네임예시2', '욕설/비방', '15:31:05', 'LIVE', [
                { time: '15:30:50', message: '방송 재밌게 보다가 갑자기 짜증나게 하네 ㅡㅡ' },
                { time: '15:31:00', message: '아 개빡치네 진짜' }
            ]);
            recordBan('닉네임예시3', '시스템 감지 [1/0]', '15:31:58', 'VOD', []);
        }, 3000);
    };

    // ──────────────────────────────────────────────────────────────
    //  13. 초기화
    // ──────────────────────────────────────────────────────────────

    const init = () => {
        // 통신 후킹은 최대한 일찍 실행 (DOM 준비 전에도)
        hookWebSocket();
        hookXHR();
        hookFetch();

        const buildUI = () => {
            injectStyles();
            createPanel();
            injectTriggerIcon();
            runDummyTest();
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', buildUI);
        } else {
            buildUI();
        }

        console.log('[채금스캐너] v0.2.0 초기화 완료 — 패널 닫혀도 데이터 누적 활성');
    };

    init();

})();
