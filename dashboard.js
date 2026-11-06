window.__ModuleLoader__.load({
  id: '@local/mission-control',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const POLL_MS = 2000;
    const ENDPOINT = '/mission-dashboard-v2.json';
    const POS_KEY = 'mission-control.window.position';
    const OPEN_KEY = 'mission-control.window.open';
    const STOP_ENDPOINT = '/mission-end-v1';
    const MARGIN = 16;

    // ── 主题 token（深色/浅色自动适配）──────────────────────────────────────
    const T = {
      bg: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      text: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    };

    const s = {
      // 悬浮窗本体：脱离文档流，覆盖在页面上方
      window: (collapsed, dragging) => ({
        position: 'fixed', right: MARGIN, bottom: 120,
        zIndex: 60, boxSizing: 'border-box',
        width: collapsed ? 'auto' : 340, maxWidth: `calc(100vw - ${MARGIN * 2}px)`,
        borderRadius: 12, border: `1px solid ${T.border}`, background: T.bg, color: T.text,
        boxShadow: '0 12px 32px rgba(0,0,0,0.24), 0 2px 8px rgba(0,0,0,0.12)',
        fontFamily: 'inherit', fontSize: 13, lineHeight: 1.45, overflow: 'hidden',
        pointerEvents: 'auto', userSelect: dragging ? 'none' : 'auto',
        transition: dragging ? 'none' : 'box-shadow .15s ease',
      }),
      head: {
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 10px', cursor: 'grab', userSelect: 'none', minHeight: 32,
      },
      dot: (color) => ({
        width: 7, height: 7, borderRadius: '50%', background: color,
        flex: 'none', display: 'inline-block',
      }),
      title: { fontWeight: 600, whiteSpace: 'nowrap' },
      meta: { color: T.secondary, fontSize: 12, whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
      bar: { flex: '1 1 70px', minWidth: 46, height: 5, borderRadius: 3, background: T.border, overflow: 'hidden' },
      barFill: (pct, color) => ({
        height: '100%', width: `${Math.max(0, Math.min(100, pct))}%`,
        background: color, transition: 'width .35s ease',
      }),
      chevron: { color: T.secondary, fontSize: 11, flex: 'none', paddingLeft: 2 },
      body: { padding: '2px 10px 8px', borderTop: `1px solid ${T.border}`, maxHeight: 380, overflowY: 'auto' },
      mission: { padding: '7px 0 5px', borderBottom: `1px solid ${T.border}` },
      missionTask: { color: T.secondary, fontSize: 12, padding: '2px 0 5px', wordBreak: 'break-word' },
      mBlock: { padding: '7px 0 6px', borderBottom: `1px solid ${T.border}` },
      mHead: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      mName: { fontWeight: 600, whiteSpace: 'nowrap' },
      badge: (color) => ({
        fontSize: 11, padding: '0 6px', borderRadius: 9, lineHeight: '16px',
        border: `1px solid ${color}`, color, whiteSpace: 'nowrap',
      }),
      mBar: { flex: '0 1 90px', minWidth: 40, height: 4, borderRadius: 2, background: T.border, overflow: 'hidden' },
      mPct: { color: T.secondary, fontSize: 11, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
      line: { display: 'flex', gap: 4, fontSize: 12, marginTop: 3, alignItems: 'baseline' },
      key: { color: T.secondary, flex: 'none' },
      val: { color: T.text, minWidth: 0, wordBreak: 'break-word' },
      sub: { color: T.secondary, fontSize: 11, marginTop: 3, wordBreak: 'break-word' },
      err: { color: T.error, fontSize: 11, marginTop: 4, wordBreak: 'break-word' },
      stopBtn: {
        flex: 'none', border: `1px solid ${T.border}`, background: 'transparent',
        color: T.error, fontFamily: 'inherit', fontSize: 11, lineHeight: '18px',
        padding: '0 7px', borderRadius: 8, cursor: 'pointer', whiteSpace: 'nowrap',
      },
      stopBtnBusy: { opacity: 0.5, cursor: 'default' },
    };

    const statusColor = (st) =>
      st === 'running' || st === 'provisioning' ? T.brand
      : st === 'failed' ? T.error : T.idle;

    const ratioColor = (r) => (r >= 0.85 ? T.error : r >= 0.65 ? T.warn : T.success);

    const baseName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    function readPosition() {
      try {
        const raw = window.localStorage.getItem(POS_KEY);
        if (!raw) return null;
        const p = JSON.parse(raw);
        return p && typeof p.x === 'number' && typeof p.y === 'number' ? { x: p.x, y: p.y } : null;
      } catch {
        return null;
      }
    }

    function readOpen() {
      try {
        const raw = window.localStorage.getItem(OPEN_KEY);
        return raw === '0' ? false : true;
      } catch {
        return true;
      }
    }

    function store(key, value) {
      try { window.localStorage.setItem(key, value); } catch { /* 隐私模式等场景忽略 */ }
    }

    function useDashboard() {
      const [snap, setSnap] = React.useState(null);
      React.useEffect(() => {
        let alive = true;
        let timer;
        const tick = async () => {
          try {
            const res = await fetch(ENDPOINT, { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (alive) setSnap(data);
          } catch {
            if (alive) setSnap({ active: false, missions: [] });
          }
        };
        tick();
        timer = setInterval(tick, POLL_MS);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      return snap;
    }

    function MemberBlock({ member }) {
      const ratio = member.ratio || 0;
      const p = Math.round(ratio * 100);
      const statusLabel = member.statusLabel || (member.status === 'running' ? '工作中' : '空闲');
      const current = member.currentSummary || (member.status === 'running' ? '工作中…' : '—');
      const done = (member.completedSummary && member.completedSummary.length)
        ? member.completedSummary
        : [];
      const files = (member.files || []).map(baseName);

      return h('div', { style: s.mBlock },
        h('div', { style: s.mHead },
          h('span', { style: s.dot(statusColor(member.status)) }),
          h('span', { style: s.mName }, member.name),
          h('span', { style: s.badge(statusColor(member.status)) }, statusLabel),
          h('span', { style: s.mBar }, h('span', { style: s.barFill(p, ratioColor(ratio)) })),
          h('span', { style: s.mPct }, `${p}%`),
        ),
        h('div', { style: s.line },
          h('span', { style: s.key }, '当前任务：'),
          h('span', { style: s.val }, current),
        ),
        h('div', { style: s.line },
          h('span', { style: s.key }, '已完成任务：'),
          done.length
            ? h('span', { style: s.val }, done.map((d, i) => h('span', { key: i }, (i ? '；' : '') + d)))
            : h('span', { style: { ...s.val, color: T.secondary } },
                member.turns
                  ? `尚未汇报（已工作 ${member.turns} 轮 / ${member.toolCalls} 次工具调用）`
                  : '尚未开始'),
        ),
        files.length > 0
          ? h('div', { style: s.sub, title: files.join('\n') }, `产出文件：${files.join('、')}`)
          : null,
      );
    }

    function MissionBlock({ mission }) {
      const mates = mission.teammates || [];
      return h('div', { style: s.mission },
        h('div', { style: s.missionTask, title: mission.task }, mission.task),
        ...mates.map((m, i) => h(MemberBlock, { key: m.name + i, member: m })),
        mission.lastError ? h('div', { style: s.err }, `⚠ ${mission.lastError}`) : null,
      );
    }

    /** 悬浮窗：固定在页面上方，可拖动、可折叠，位置与折叠状态写入 localStorage。 */
    function FloatingWindow() {
      const snap = useDashboard();
      const [open, setOpen] = React.useState(readOpen);
      const [pos, setPos] = React.useState(readPosition);
      const [dragging, setDragging] = React.useState(false);
      const [stopping, setStopping] = React.useState(false);
      const [ended, setEnded] = React.useState(null);

      const rootRef = React.useRef(null);
      const dragRef = React.useRef(null);

      const missions = (snap && snap.active && snap.missions) || [];

      const hasPos = pos !== null;
      React.useEffect(() => {
        if (!hasPos) return undefined;
        const onResize = () => {
          setPos((p) => {
            if (!p) return p;
            const el = rootRef.current;
            const w = el ? el.offsetWidth : 340;
            return {
              x: clamp(p.x, MARGIN, Math.max(MARGIN, window.innerWidth - w - MARGIN)),
              y: clamp(p.y, MARGIN, Math.max(MARGIN, window.innerHeight - 40)),
            };
          });
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, [hasPos]);

      if (missions.length === 0) {
        if (!ended) return null;
        const endedStyle = s.window(false, false);
        if (pos) {
          endedStyle.left = pos.x;
          endedStyle.top = pos.y;
          endedStyle.right = 'auto';
          endedStyle.bottom = 'auto';
        }
        return h('div', {
          ref: rootRef,
          style: endedStyle,
          role: 'status',
          'aria-label': '项目已结束',
        },
          h('div', { style: s.head },
            h('span', { style: s.dot(T.success) }),
            h('span', { style: s.title }, '项目已结束'),
            h('span', { style: s.meta }, ended.summary || ''),
          ),
        );
      }

      let mateCount = 0;
      let runningCount = 0;
      let total = 0;
      let completed = 0;
      for (const m of missions) {
        const mates = m.teammates || [];
        const board = m.board || {};
        mateCount += mates.length;
        runningCount += mates.filter((x) => x.status === 'running').length;
        total += board.total || 0;
        completed += board.completed || 0;
      }
      const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

      const toggle = () => {
        setOpen((v) => {
          const next = !v;
          store(OPEN_KEY, next ? '1' : '0');
          return next;
        });
      };

      const onPointerDown = (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const el = rootRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        dragRef.current = {
          id: e.pointerId,
          dx: e.clientX - rect.left,
          dy: e.clientY - rect.top,
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
        };
        if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
      };

      const onPointerMove = (e) => {
        const d = dragRef.current;
        if (!d || d.id !== e.pointerId) return;
        if (!d.moved) {
          if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) < 4) return;
          d.moved = true;
          setDragging(true);
        }
        const el = rootRef.current;
        const w = el ? el.offsetWidth : 340;
        setPos({
          x: clamp(e.clientX - d.dx, MARGIN, Math.max(MARGIN, window.innerWidth - w - MARGIN)),
          y: clamp(e.clientY - d.dy, MARGIN, Math.max(MARGIN, window.innerHeight - 40)),
        });
      };

      const clearDrag = (e) => {
        const d = dragRef.current;
        if (!d || d.id !== e.pointerId) return undefined;
        dragRef.current = null;
        if (e.currentTarget.releasePointerCapture) {
          try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
        }
        setDragging(false);
        return d;
      };

      const endDrag = (e) => {
        const d = clearDrag(e);
        if (!d) return;
        if (d.moved) {
          setPos((p) => {
            if (p) store(POS_KEY, JSON.stringify(p));
            return p;
          });
        } else {
          toggle();
        }
      };

      const cancelDrag = (e) => {
        clearDrag(e);
      };

      // 结束任务：停止所有子会话 + 保留结果文件 + 删除临时文件
      const onEnd = async (e) => {
        e.stopPropagation();
        if (stopping) return;
        const ask = [
          '确定结束本次项目？',
          '',
          `· 所有子会话立即停止工作${mateCount ? `（共 ${mateCount} 个，${runningCount} 个运行中）` : ''}`,
          '· 结果文件保留',
          '· 临时文件（*.tmp / *.log / *.bak 等）将被删除',
          '',
          '此操作不可撤销。',
        ].join('\n');
        if (typeof window.confirm === 'function' && !window.confirm(ask)) return;
        setStopping(true);
        try {
          const res = await fetch(STOP_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          });
          const result = await res.json().catch(() => ({}));
          const deleted = (result.cleanup && result.cleanup.deleted) || [];
          const interrupted = result.interrupted || [];
          setEnded({
            summary: `已停止 ${interrupted.length} 个子会话 · 清理 ${deleted.length} 个临时文件`,
          });
        } catch {
          // 网络失败时保持面板不动，轮询会显示真实状态
        } finally {
          setStopping(false);
        }
      };

      const head = h('div', {
        style: { ...s.head, cursor: dragging ? 'grabbing' : 'grab' },
        role: 'button',
        tabIndex: 0,
        'aria-expanded': open,
        'aria-label': open ? '折叠蜂巢任务悬浮窗' : '展开蜂巢任务悬浮窗',
        title: '拖动可移动，点击可折叠',
        onPointerDown,
        onPointerMove,
        onPointerUp: endDrag,
        onPointerCancel: cancelDrag,
        onKeyDown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        },
      },
        h('span', { style: s.dot(runningCount > 0 ? T.brand : T.success) }),
        h('span', { style: s.title }, '蜂巢任务'),
        h('span', { style: s.meta }, `${mateCount} 工蜂${runningCount ? ` · ${runningCount} 工作中` : ' · 全部空闲'}`),
        open ? h('span', { style: s.bar }, h('span', { style: s.barFill(pct, T.success) })) : null,
        open ? h('span', { style: s.meta }, `${pct}%`) : null,
        open ? h('button', {
          type: 'button',
          style: stopping ? { ...s.stopBtn, ...s.stopBtnBusy } : s.stopBtn,
          disabled: stopping,
          title: '结束本次项目：停止所有子会话，保留结果文件，删除临时文件',
          'aria-label': '结束本次项目',
          onClick: onEnd,
          onPointerDown: (e) => e.stopPropagation(),
          onPointerMove: (e) => e.stopPropagation(),
          onPointerUp: (e) => e.stopPropagation(),
          onPointerCancel: (e) => e.stopPropagation(),
          onKeyDown: (e) => e.stopPropagation(),
        }, stopping ? '结束中…' : '结束任务') : null,
        h('span', { style: s.chevron }, open ? '▲' : '▼'),
      );

      const style = s.window(open === false, dragging);
      if (pos) {
        style.left = pos.x;
        style.top = pos.y;
        style.right = 'auto';
        style.bottom = 'auto';
      }

      return h('div', {
        ref: rootRef,
        style,
        role: 'dialog',
        'aria-label': '蜂巢任务面板',
      },
        head,
        open
          ? h('div', { style: s.body }, ...missions.map((m, i) => h(MissionBlock, { key: m.sessionId || i, mission: m })))
          : null,
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 全局悬浮层：只在需要覆盖整页的悬浮 UI 时使用
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'mission-dashboard',
          order: -30,
        }, FloatingWindow));
      },
    };
  },
});
