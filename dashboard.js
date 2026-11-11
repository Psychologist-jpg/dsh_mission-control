window.__ModuleLoader__.load({
  id: '@local/mission-control',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;

    const POLL_MS = 2000;
    const ENDPOINT = '/mission-dashboard-v2.json';
    const POS_KEY = 'mission-control.window.position';
    const OPEN_KEY = 'mission-control.window.open';
    const STOP_ENDPOINT = '/mission-end-v1';
    const MODE_ENDPOINT = '/mission-mode-v1';
    const CHILDREN_ENDPOINT = '/mission-children-v1';
    const DELETE_ENDPOINT = '/mission-delete-v1';
    const ARCHIVE_ENDPOINT = '/mission-archive-v1';
    const MARGIN = 16;

    // ── 主题 token（深色/浅色自动适配）──────────────────────────────────────
    const T = {
      bg: 'var(--dsw-alias-bg-layer-2)',
      // 浮层（下拉菜单 / 弹窗）背景：与宿主菜单一致，缺失时退回面板色
      panelBg: 'var(--dsw-specific-menu, var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2)))',
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

    function readPosition(key, index = 0) {
      try {
        const raw = window.localStorage.getItem(`${POS_KEY}:${key}`);
        if (!raw) {
          // 多窗口时默认错开，避免完全重叠
          return { x: window.innerWidth - 360 - MARGIN, y: 120 + index * 28 };
        }
        const p = JSON.parse(raw);
        return p && typeof p.x === 'number' && typeof p.y === 'number' ? { x: p.x, y: p.y } : null;
      } catch {
        return null;
      }
    }

    function readOpen(key) {
      try {
        const raw = window.localStorage.getItem(`${OPEN_KEY}:${key}`);
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
        member.model || member.actualModel
          ? h('div', { style: s.sub }, `模型：${member.actualModel || member.model}`)
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

    /** 子会话上限选择器：自绘下拉，避免原生 select 弹层在深色主题下白底看不清。 */
    function NumberPicker({ value, disabled, onChange }) {
      const [open, setOpen] = React.useState(false);
      const [rect, setRect] = React.useState(null);
      const [hover, setHover] = React.useState(null);
      const btnRef = React.useRef(null);

      React.useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => {
          const target = e.target;
          if (target && target.closest && target.closest('[data-mission-picker]')) return;
          setOpen(false);
        };
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        const onScroll = () => setOpen(false);
        window.addEventListener('pointerdown', onDown, true);
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', onScroll);
        window.addEventListener('scroll', onScroll, true);
        return () => {
          window.removeEventListener('pointerdown', onDown, true);
          window.removeEventListener('keydown', onKey, true);
          window.removeEventListener('resize', onScroll);
          window.removeEventListener('scroll', onScroll, true);
        };
      }, [open]);

      const toggle = () => {
        if (disabled) return;
        const el = btnRef.current;
        if (el) setRect(el.getBoundingClientRect());
        setOpen((v) => !v);
        setHover(null);
      };

      const pick = (n) => {
        setOpen(false);
        onChange(n);
      };

      const btnStyle = {
        display: 'inline-flex', alignItems: 'center', gap: 3,
        minWidth: 40, height: 22, padding: '0 5px', borderRadius: 6,
        border: `1px solid ${T.border}`, background: 'transparent',
        color: T.text, fontFamily: 'inherit', fontSize: 12,
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
      };

      const menu = open && rect
        ? ReactDOM.createPortal(
            h('div', {
              'data-mission-picker': '1',
              style: {
                position: 'fixed',
                left: Math.round(rect.left),
                top: Math.round(rect.bottom + 4),
                zIndex: 9999,
                pointerEvents: 'auto',
                minWidth: Math.max(56, Math.round(rect.width)),
                maxHeight: 260,
                overflowY: 'auto',
                padding: 4,
                borderRadius: 10,
                border: `1px solid ${T.border}`,
                background: T.panelBg,
                backdropFilter: 'var(--dsw-menu-backdrop-filter, blur(12px))',
                boxShadow: 'var(--dsw-elevation-prominent, 0 10px 32px rgba(0,0,0,.28))',
                color: T.text,
                fontFamily: 'inherit',
                fontSize: 12,
              },
            }, ...[2,3,4,5,6,7,8,9,10].map((n) => h('div', {
              key: n,
              role: 'option',
              'aria-selected': n === value,
              onPointerEnter: () => setHover(n),
              onPointerLeave: () => setHover((cur) => (cur === n ? null : cur)),
              onClick: () => pick(n),
              style: {
                padding: '4px 8px', borderRadius: 6, cursor: 'pointer',
                color: T.text,
                background: n === value
                  ? 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.08))'
                  : (hover === n ? 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.06))' : 'transparent'),
                fontWeight: n === value ? 600 : 400,
                fontVariantNumeric: 'tabular-nums',
              },
            }, String(n)))),
            document.body,
          )
        : null;

      return h('span', { 'data-mission-picker': '1', style: { display: 'inline-flex', alignItems: 'center' } },
        h('button', {
          ref: btnRef,
          type: 'button',
          style: btnStyle,
          disabled,
          title: '子会话数量上限（2–10）',
          'aria-label': '子会话数量上限',
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          onClick: toggle,
        }, String(value), h('span', { style: { color: T.secondary, fontSize: 9 } }, '▾')),
        menu,
      );
    }

    /** 子会话管理弹窗：勾选后删除（停止 + 归档，可选删日志）。 */
    function ChildManager({ sessionId, onClose }) {
      const [children, setChildren] = React.useState(null);
      const [picked, setPicked] = React.useState(() => new Set());
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState('');
      const [archivedCount, setArchivedCount] = React.useState(0);
      const [deletedCount, setDeletedCount] = React.useState(0);

      const load = React.useCallback(async () => {
        try {
          const url = `${CHILDREN_ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}&includeArchived=1&includeDeleted=1`;
          const res = await fetch(url, { cache: 'no-store' });
          const data = await res.json();
          setChildren(data.children || []);
          setArchivedCount(Number(data.archivedCount) || 0);
          setDeletedCount(Number(data.deletedCount) || 0);
        } catch {
          setChildren([]);
        }
      }, [sessionId]);

      React.useEffect(() => { load(); }, [load]);

      const toggle = (id) => {
        setPicked((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
        });
      };
      const allPicked = children && children.length > 0 && picked.size === children.length;
      const toggleAll = () => {
        setPicked(allPicked ? new Set() : new Set((children || []).map((c) => c.id)));
      };

      const archive = async (action) => {
        if (busy || picked.size === 0) return;
        const isRestore = action === 'unarchive';
        const names = (children || []).filter((c) => picked.has(c.id)).map((c) => c.name);
        const ask = isRestore
          ? `确定取消归档以下 ${names.length} 个子会话？\n\n${names.join('、')}\n\n它们会重新出现在会话列表中。`
          : [
              `确定归档以下 ${names.length} 个子会话？`,
              '',
              names.join('、'),
              '',
              '· 会话被停止',
              '· 从会话列表移走，日志保留',
              '· 之后可「取消归档」恢复',
            ].join('\n');
        if (typeof window.confirm === 'function' && !window.confirm(ask)) return;
        setBusy(true);
        setMessage('');
        try {
          const res = await fetch(ARCHIVE_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, childIds: [...picked], action: isRestore ? 'unarchive' : 'archive' }),
          });
          const result = await res.json().catch(() => ({}));
          const okCount = ((isRestore ? result.restored : result.archived) || []).length;
          const errs = (result.errors || []).length;
          setMessage(`${isRestore ? '已取消归档' : '已归档'} ${okCount} 个子会话${errs ? `，${errs} 个失败` : ''}`);
          setPicked(new Set());
          await load();
        } catch {
          setMessage('操作失败：无法连接插件端点');
        } finally {
          setBusy(false);
        }
      };

      const remove = async () => {
        if (busy || picked.size === 0) return;
        const names = (children || []).filter((c) => picked.has(c.id)).map((c) => c.name);
        const ask = [
          `确定彻底删除以下 ${names.length} 个子会话？`,
          '',
          names.join('、'),
          '',
          '· 会话被立即停止',
          '· 会话日志与缓存从磁盘删除',
          '· 不再出现在任何列表中',
          '',
          '此操作不可恢复。',
        ].join('\n');
        if (typeof window.confirm === 'function' && !window.confirm(ask)) return;
        setBusy(true);
        setMessage('');
        try {
          const res = await fetch(DELETE_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, childIds: [...picked], hard: true }),
          });
          const result = await res.json().catch(() => ({}));
          const okCount = (result.deleted || []).length;
          const errs = (result.errors || []).length;
          const logs = Number(result.removedLogs) || 0;
          setMessage(`已彻底删除 ${okCount} 个子会话（清除 ${logs} 份会话日志）${errs ? `，${errs} 个失败` : ''}`);
          setPicked(new Set());
          await load();
        } catch {
          setMessage('删除失败：无法连接插件端点');
        } finally {
          setBusy(false);
        }
      };

      const overlay = {
        position: 'fixed', inset: 0, zIndex: 10000, pointerEvents: 'auto',
        background: 'rgba(0,0,0,.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      };
      const panel = {
        width: 'min(520px, calc(100vw - 48px))',
        maxHeight: 'min(70vh, 640px)',
        display: 'flex', flexDirection: 'column',
        borderRadius: 12, border: `1px solid ${T.border}`,
        background: T.panelBg, backdropFilter: 'var(--dsw-menu-backdrop-filter, blur(12px))',
        boxShadow: 'var(--dsw-elevation-prominent, 0 16px 44px rgba(0,0,0,.35))',
        color: T.text, fontFamily: 'inherit', fontSize: 13, overflow: 'hidden',
      };
      const rowStyle = {
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 10px', borderRadius: 8, cursor: 'pointer',
      };

      const body = !children
        ? h('div', { style: { padding: 16, color: T.secondary } }, '加载中…')
        : h('div', { style: { padding: '6px 8px', overflowY: 'auto' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '2px 10px 6px',
              color: T.secondary, fontSize: 12, flexWrap: 'wrap' } },
              h('span', null, `普通 ${(children || []).filter((c) => c.exists && !c.archived).length}`),
              h('span', null, `归档 ${archivedCount}`),
              h('span', null, `已删除 ${deletedCount}`),
            ),
            children.length === 0
              ? h('div', { style: { padding: '10px 8px', color: T.secondary, fontSize: 12 } }, '当前没有子会话。')
              : null,
            ...children.map((child, index) => {
              // 组标题：普通 / 归档 / 已删除
              const rank = !child.exists ? 2 : child.archived ? 1 : 0
              const prevRank = index === 0
                ? -1
                : (() => { const p = children[index - 1]; return !p.exists ? 2 : p.archived ? 1 : 0 })()
              const groupTitle = rank !== prevRank
                ? (rank === 0 ? '普通会话' : rank === 1 ? '归档会话' : '已删除会话')
                : null
              return h(React.Fragment, { key: child.id },
                groupTitle
                  ? h('div', { style: { padding: '6px 10px 2px', color: T.secondary, fontSize: 11, fontWeight: 600 } }, groupTitle)
                  : null,
                h('label', { style: { ...rowStyle, opacity: child.exists ? 1 : 0.55 } },
                  h('input', {
                    type: 'checkbox',
                    checked: picked.has(child.id),
                    disabled: !child.exists,
                    onChange: () => toggle(child.id),
                  }),
                  h('span', { style: { fontWeight: 500 } }, child.name),
                  h('span', {
                    style: {
                      fontSize: 11, padding: '0 6px', borderRadius: 9, lineHeight: '16px',
                      border: `1px solid ${!child.exists ? T.error : child.archived ? T.border : child.status === 'running' ? T.brand : T.idle}`,
                      color: !child.exists ? T.error : child.archived ? T.secondary : child.status === 'running' ? T.brand : T.secondary,
                    },
                  }, !child.exists ? '已删除' : child.archived ? '已归档' : child.status === 'running' ? '运行中' : '空闲'),
                  h('span', {
                    style: { marginLeft: 'auto', color: T.secondary, fontSize: 11, maxWidth: 160,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    title: child.description || '',
                  }, child.description || ''),
                ),
              )
            }),
          );

      return ReactDOM.createPortal(
        h('div', {
          style: overlay,
          onPointerDown: (e) => { if (e.target === e.currentTarget) onClose(); },
        },
          h('div', { style: panel, role: 'dialog', 'aria-label': '子会话管理' },
            h('div', {
              style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
                borderBottom: `1px solid ${T.border}`, fontWeight: 600 },
            }, '子会话管理', h('span', { style: { marginLeft: 'auto' } })),
            body,
            message ? h('div', { style: { padding: '0 12px 6px', color: T.success, fontSize: 12 } }, message) : null,
            h('div', {
              style: { display: 'flex', gap: 8, justifyContent: 'flex-end',
                padding: '10px 12px', borderTop: `1px solid ${T.border}` },
            },
              h('button', {
                type: 'button',
                onClick: onClose,
                style: { padding: '4px 12px', borderRadius: 8, border: `1px solid ${T.border}`,
                  background: 'transparent', color: T.text, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 },
              }, '关闭'),
              h('button', {
                type: 'button',
                disabled: busy || picked.size === 0,
                onClick: () => archive('archive'),
                title: '归档（可恢复）：从会话列表移走，日志保留',
                style: { padding: '4px 12px', borderRadius: 8, border: `1px solid ${T.brand}`,
                  background: 'transparent', color: T.brand, cursor: picked.size === 0 ? 'default' : 'pointer',
                  opacity: busy || picked.size === 0 ? 0.5 : 1, fontFamily: 'inherit', fontSize: 12 },
              }, busy ? '处理中…' : `归档所选（${picked.size}）`),
              h('button', {
                type: 'button',
                disabled: busy || picked.size === 0,
                onClick: () => archive('unarchive'),
                title: '取消归档：让会话重新出现在列表中',
                style: { padding: '4px 12px', borderRadius: 8, border: `1px solid ${T.border}`,
                  background: 'transparent', color: T.secondary, cursor: picked.size === 0 ? 'default' : 'pointer',
                  opacity: busy || picked.size === 0 ? 0.5 : 1, fontFamily: 'inherit', fontSize: 12 },
              }, '取消归档'),
              h('button', {
                type: 'button',
                disabled: busy || picked.size === 0,
                onClick: remove,
                title: '彻底删除（不可恢复）',
                style: { padding: '4px 12px', borderRadius: 8, border: `1px solid ${T.error}`,
                  background: 'transparent', color: T.error, cursor: picked.size === 0 ? 'default' : 'pointer',
                  opacity: busy || picked.size === 0 ? 0.5 : 1, fontFamily: 'inherit', fontSize: 12 },
              }, busy ? '删除中…' : `彻底删除（${picked.size}）`),
            ),
          ),
        ),
        document.body,
      );
    }

    /** 会话头部的蜂巢模式开关 + 子会话上限选择（2–10）。 */
    function HiveToggle(props) {
      const sessionId = props.sessionId;
      const [state, setState] = React.useState({ active: false, enabled: false, cap: 3 });
      const [busy, setBusy] = React.useState(false);
      const [showManager, setShowManager] = React.useState(false);

      const load = React.useCallback(async () => {
        try {
          const res = await fetch(ENDPOINT, { cache: 'no-store' });
          const data = await res.json();
          const mine = (data.missions || []).find((m) => m.sessionId === sessionId);
          setState({
            active: Boolean(mine),
            enabled: Boolean(mine) && mine.paused !== true,
            cap: mine && Number.isFinite(mine.cap) ? mine.cap : 3,
          });
        } catch {
          // 忽略，保留上一次状态
        }
      }, [sessionId]);

      React.useEffect(() => {
        let alive = true;
        load();
        const timer = setInterval(() => { if (alive) load(); }, 3000);
        return () => { alive = false; clearInterval(timer); };
      }, [load]);

      const push = async (enabled, cap, workersOnly = false) => {
        if (busy) return;
        setBusy(true);
        if (!workersOnly) setState((s) => ({ ...s, active: enabled ? true : s.active, enabled }));
        try {
          const payload = { sessionId, enabled, workers: cap };
          if (workersOnly) payload.workersOnly = true;
          const res = await fetch(MODE_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const result = await res.json().catch(() => ({}));
          if (result && result.ok) {
            setState((s) => ({
              active: Boolean(result.active),
              // workersOnly 不改启停状态
              enabled: workersOnly ? s.enabled : Boolean(result.enabled),
              cap: Number.isFinite(result.cap) ? result.cap : cap,
            }));
          } else {
            await load();
          }
        } catch {
          await load();
        } finally {
          setBusy(false);
        }
      };

      const onToggle = () => push(!state.enabled, state.cap);

      const tunStyle = {
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '0 6px', height: 26, borderRadius: 8,
        color: T.text, fontFamily: 'inherit', fontSize: 12,
      };

      const switchStyle = {
        position: 'relative', width: 34, height: 18, borderRadius: 9,
        border: `1px solid ${state.enabled ? T.success : T.border}`,
        background: state.enabled ? T.success : 'transparent',
        cursor: busy ? 'default' : 'pointer', flex: 'none',
        opacity: busy ? 0.6 : 1, padding: 0, transition: 'background .18s ease',
      };
      const knob = {
        position: 'absolute', top: 1.5, left: state.enabled ? 17 : 1.5,
        width: 13, height: 13, borderRadius: '50%',
        background: state.enabled ? '#fff' : T.secondary,
        transition: 'left .18s ease',
      };

      const label = !state.active ? '普通' : state.enabled ? '蜂巢' : '已暂停';

      return h('span', { style: tunStyle, title: '蜂巢会话模式：开启后主会话的消息会下发给子会话' },
        h('button', {
          type: 'button', role: 'switch', 'aria-checked': state.enabled,
          'aria-label': '蜂巢会话模式开关',
          style: switchStyle, disabled: busy, onClick: onToggle,
        }, h('span', { style: knob })),
        h('span', { style: { color: state.enabled ? T.success : T.secondary, whiteSpace: 'nowrap' } }, label),
        h(NumberPicker, {
          value: state.cap,
          disabled: busy,
          onChange: (n) => { push(state.enabled, n, true); },
        }),
        h('span', { style: { color: T.secondary, fontSize: 11 } }, '个'),
        h('button', {
          type: 'button',
          title: '管理子会话（可勾选删除）',
          'aria-label': '管理子会话',
          onClick: () => setShowManager(true),
          style: {
            display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 7px',
            borderRadius: 6, border: `1px solid ${T.border}`, background: 'transparent',
            color: T.secondary, fontFamily: 'inherit', fontSize: 12, cursor: 'pointer',
            marginLeft: 2,
          },
        }, '子会话'),
        showManager ? h(ChildManager, { sessionId, onClose: () => setShowManager(false) }) : null,
      );
    }

    /** 悬浮窗：固定在页面上方，可拖动、可折叠，位置与折叠状态写入 localStorage。 */
    function MissionWindow({ mission, index, onEnded }) {
      const storeKey = mission.sessionId || 'default';
      const [open, setOpen] = React.useState(() => readOpen(storeKey));
      const [pos, setPos] = React.useState(() => readPosition(storeKey, index));
      const [dragging, setDragging] = React.useState(false);
      const [stopping, setStopping] = React.useState(false);

      const rootRef = React.useRef(null);
      const dragRef = React.useRef(null);

      const missions = [mission];

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

      if (!mission) return null;

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
      const paused = missions.some((m) => m.paused === true);
      const scale = mission.scale || null;
      const workerLabel = scale
        ? `${scale.workers}/${scale.cap} 工蜂${scale.openTasks ? ` · 待办 ${scale.openTasks}` : ''}${scale.gap > 0 ? ` · 建议再开 ${scale.gap}` : ''}`
        : `${mateCount} 工蜂`;

      const toggle = () => {
        setOpen((v) => {
          const next = !v;
          store(`${OPEN_KEY}:${storeKey}`, next ? '1' : '0');
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
            if (p) store(`${POS_KEY}:${storeKey}`, JSON.stringify(p));
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
            // 必须带本窗口所属主会话：后端不会退化为「结束全部」
            body: JSON.stringify({ sessionId: mission.sessionId }),
          });
          const result = await res.json().catch(() => ({}));
          // 后端失败（400 缺 sessionId / 404 无该任务 / 500）绝不能显示成功卡片
          if (!res.ok || result.ok === false) {
            const reason = (result && (result.message || result.error)) || `HTTP ${res.status}`;
            window.alert(`结束任务失败：${reason}`);
            return;
          }
          const deleted = (result.cleanup && result.cleanup.deleted) || [];
          const interrupted = result.interrupted || [];
          const files = result.resultFiles || [];
          if (typeof onEnded === 'function') {
            onEnded({
              sessionId: mission.sessionId,
              title: mission.title || '蜂巢任务',
              summary: `已停止 ${interrupted.length} 个子会话 · 清理 ${deleted.length} 个临时文件 · 保留 ${files.length} 个结果文件${result.leadNotified ? ' · 已请求主会话汇总' : ''}`,
            })
          }
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
        h('span', { style: { ...s.title, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }, title: mission.title || '' },
          mission.title || '蜂巢任务'),
        h('span', { style: s.meta }, `${workerLabel}${runningCount ? ` · ${runningCount} 工作中` : ''}${paused ? ' · 已暂停' : ''}`),
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

    /** 结束提示小卡片：可拖动、可关闭，15 秒后自动消失。 */
    function EndedCard({ info, index, onClose }) {
      const storeKey = `ended:${info.sessionId || 'default'}`;
      const [pos, setPos] = React.useState(() => readPosition(storeKey, index));
      const [dragging, setDragging] = React.useState(false);
      const rootRef = React.useRef(null);
      const dragRef = React.useRef(null);

      const onPointerDown = (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const el = rootRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        dragRef.current = { id: e.pointerId, dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
      };
      const onPointerMove = (e) => {
        const d = dragRef.current;
        if (!d || d.id !== e.pointerId) return;
        setDragging(true);
        const el = rootRef.current;
        const w = el ? el.offsetWidth : 300;
        setPos({
          x: clamp(e.clientX - d.dx, MARGIN, Math.max(MARGIN, window.innerWidth - w - MARGIN)),
          y: clamp(e.clientY - d.dy, MARGIN, Math.max(MARGIN, window.innerHeight - 40)),
        });
      };
      const onPointerUp = (e) => {
        const d = dragRef.current;
        if (!d || d.id !== e.pointerId) return;
        dragRef.current = null;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
        setDragging(false);
        setPos((p) => {
          if (p) store(`${POS_KEY}:${storeKey}`, JSON.stringify(p));
          return p;
        });
      };

      const cardStyle = s.window(true, dragging);
      if (pos) {
        cardStyle.left = pos.x;
        cardStyle.top = pos.y;
        cardStyle.right = 'auto';
        cardStyle.bottom = 'auto';
      }
      cardStyle.maxWidth = 360;

      return h('div', {
        ref: rootRef,
        style: cardStyle,
        role: 'status',
        'aria-label': '项目已结束',
      },
        h('div', {
          style: { ...s.head, cursor: dragging ? 'grabbing' : 'grab' },
          onPointerDown, onPointerMove, onPointerUp,
          title: '拖动可移动',
        },
          h('span', { style: s.dot(T.success) }),
          h('span', { style: { ...s.title, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' } }, info.title || '项目已结束'),
          h('span', { style: { ...s.meta, flex: '1 1 auto', whiteSpace: 'normal' } }, info.summary || ''),
          h('button', {
            type: 'button',
            title: '关闭',
            'aria-label': '关闭结束提示',
            onClick: onClose,
            onPointerDown: (e) => e.stopPropagation(),
            onPointerMove: (e) => e.stopPropagation(),
            onPointerUp: (e) => e.stopPropagation(),
            style: {
              flex: 'none', border: 0, background: 'transparent', color: T.secondary,
              fontFamily: 'inherit', fontSize: 14, lineHeight: 1, padding: '2px 4px',
              cursor: 'pointer', borderRadius: 6,
            },
          }, '×'),
        ),
      );
    }

    /** 全局入口：为每个主会话渲染独立悬浮窗。 */
    function Dashboard() {
      const snap = useDashboard();
      const [ended, setEnded] = React.useState(null);

      React.useEffect(() => {
        if (!ended) return undefined;
        const timer = setTimeout(() => setEnded(null), 15000);
        return () => clearTimeout(timer);
      }, [ended]);

      const missions = (snap && snap.active && snap.missions) || [];
      const onEnded = (info) => setEnded(info);

      if (missions.length === 0 && !ended) return null;
      return h(React.Fragment, null,
        ...missions.map((m, i) => h(MissionWindow, {
          key: m.sessionId || i,
          mission: m,
          index: i,
          onEnded,
        })),
        ended ? h(EndedCard, {
          key: `ended-${ended.sessionId || 'x'}`,
          info: ended,
          index: missions.length,
          onClose: () => setEnded(null),
        }) : null,
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 会话头部：蜂巢模式开关 + 子会话上限选择
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'mission-hive-toggle',
          order: -25,
        }, HiveToggle));
        // 全局悬浮层：每个主会话一个监控悬浮窗
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'mission-dashboard',
          order: -30,
        }, Dashboard));
      },
    };
  },
});
