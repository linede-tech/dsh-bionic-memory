window.__ModuleLoader__.load({
  id: '@local/dsh-bionic-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'bionic-memory';

    const zh = {
      title: '仿生永续记忆',
      subtitle: '脑内记忆与梦境监视器',
      launcher: '记忆',
      tabScratchpad: '潜意识',
      tabEpisodes: '情景',
      tabHabits: '习惯',
      tabSkills: '本能',
      tabDreams: '梦境',
      tabGraph: '图谱',
      tabContext: '上下文',
      mood: '情绪基调',
      valence: '情绪价',
      arousal: '唤醒度',
      dreamAfterglow: '梦境余韵',
      noAfterglow: '还没有梦境余韵。',
      curiosity: '潜意识的待求证',
      noCuriosity: '暂时没有悬而未决的好奇。',
      lastChat: '上次交互',
      lastDream: '上次做梦',
      unknown: '未知',
      workingMemory: '工作记忆',
      noMemories: '还没有记忆。聊几句，然后回来看看。',
      clear: '高清',
      summarized: '梗概',
      faded: '褪色',
      retention: '保留率',
      emotion: '情绪',
      surprise: '惊奇',
      habits: '习惯与图式',
      noHabits: '还没有折叠出习惯。同类情景重复三次以上才会坍缩。',
      occurrences: '次重复',
      stability: '稳固度',
      anchor: '例外锚点',
      historical: '历史旧印象',
      active: '活跃',
      skills: '经验与本能',
      noSkills: '还没有内化出本能。被纠正或高光时刻会被炼成 If-Then。',
      confidence: '置信度',
      source: '来源',
      dreams: '梦境日记',
      noDreams: '还没有做过梦。',
      dreamNow: '现在做梦',
      dreaming: '正在做梦…',
      narrative: '梦境正文',
      remembered: '醒来后保留',
      temp: '采样温度',
      model: '生成方式',
      samples: '抽取的记忆碎片',
      moodShift: '情绪变化',
      refresh: '刷新',
      forget: '遗忘',
      forgetTarget: '遗忘目标',
      forgetFaded: '褪色情景',
      forgetHabits: '历史习惯',
      forgetSkills: '全部本能',
      forgetAll: '全部记忆',
      confirmForget: '确定要执行遗忘吗？此操作不可撤销。',
      graph: '印象图谱',
      noGraph: '还没有形成关联。折叠、做梦都会在记忆之间拉线。',
      legendEpisode: '情景',
      legendHabit: '习惯',
      legendSkill: '本能',
      legendDream: '梦境',
      context: '注入的上下文',
      contextNote: '这是最近一次推理前注入 System Prompt 的完整 XML。',
      noContext: '还没有生成上下文；下一次推理前会自动生成。',
      backend: '存储',
      loading: '加载中…',
      error: '出错了',
      close: '关闭',
      forgetDone: '遗忘完成',
      episodes: '情景',
      sessions: '会话',
      journal: '最近日志',
      noJournal: '还没有日志。',
      sqlite: 'SQLite',
      json: 'JSON 兜底',
      openPanel: '打开脑内监视器',
      closePanel: '关闭',
      activeHabits: '活跃',
      history: '历史',
      dreamAt: '做梦于',
      contextRenderedAt: '渲染于',
      never: '从未',
      totalEpisodes: '情景',
      totalHabits: '习惯',
      totalSkills: '本能',
      totalDreams: '梦',
      distilled: '降维',
      purged: '抹除',
      batch: '批处理',
      sourceUser: '用户亲述',
      sourceInferred: '我的推测',
      sourceDream: '梦境生成',
      parallel: '并行窗口',
      noParallel: '暂无其他活跃窗口',
      archived: '已归档',
      archivedSkills: '归档本能',
      dreamCacheNote: '完整梦境仅你可见；模型只看到百字余韵，用户追问时才读取缓存。',
      fallibilityAnchors: '记性趣事',
      noFallibilityAnchors: '还没有被纠正过',
      metaEvolution: '元认知进化',
      noMetaEvolution: '还没有进化记录',
      pendingProposals: '待审批提案',
      trialActive: '试用中',
      metaNightmare: '做噩梦未遂',
      contextMetabolism: '呼吸代谢',
      noContextMetabolism: '尚未测量上下文水位',
      contextWaterline: '水位',
      contextPeak: '峰值',
      contextThresholds: '水位线',
      contextDehydrated: '工具脱水',
      contextCollapsed: '折叠',
      contextOpenLoops: '未完成话题',
      contextHandover: '余温接力',
      contextBatch: '阶梯折叠',
      cacheMonitor: '缓存省钱监视器',
      cacheHit: '大脑 KV 命中率',
      cacheSaved: '今日省下',
      cacheLow: '连续低命中',
      cacheAlert: '缓存告警',
      cacheBatch: '阶梯轮',
      cacheTokens: 'tokens',
      voiceMirror: '语感镜像',
      voiceFamiliarity: '熟稔度',
      voiceAcquired: '耳濡目染',
      voiceNotes: '睡眠语感笔记',
      voiceNoNotes: '今晚还没复盘出新直觉；聊到自然时它会自己长出来。',
      voiceMoments: '高共鸣瞬间',
      voiceNoMoments: '还没有足够清晰的共鸣瞬间',
      voiceHint: '全部来自你们真实的交流；没有外部台词本。每晚 /dream 后会冻结进 Tier 1。',
      voiceLevel: '阶段',
    };

    const en = {
      title: 'Bionic memory',
      subtitle: 'Brain-side memory and dream monitor',
      launcher: 'Memory',
      tabScratchpad: 'Subconscious',
      tabEpisodes: 'Episodes',
      tabHabits: 'Habits',
      tabSkills: 'Instincts',
      tabDreams: 'Dreams',
      tabGraph: 'Graph',
      tabContext: 'Context',
      mood: 'Mood',
      valence: 'Valence',
      arousal: 'Arousal',
      dreamAfterglow: 'Dream afterglow',
      noAfterglow: 'No dream residue yet.',
      curiosity: 'Unresolved curiosity',
      noCuriosity: 'Nothing is pending curiosity right now.',
      lastChat: 'Last chat',
      lastDream: 'Last dream',
      unknown: 'unknown',
      workingMemory: 'Working memory',
      noMemories: 'No memories yet. Talk for a while and come back.',
      clear: 'clear',
      summarized: 'gist',
      faded: 'faded',
      retention: 'retention',
      emotion: 'emotion',
      surprise: 'surprise',
      habits: 'Habits & schemas',
      noHabits: 'No habit has collapsed yet. Three similar episodes are needed.',
      occurrences: 'repeats',
      stability: 'stability',
      anchor: 'exception anchor',
      historical: 'historical impression',
      active: 'active',
      skills: 'Procedural instincts',
      noSkills: 'No instinct internalized yet. Corrections and highlights become If-Then rules.',
      confidence: 'confidence',
      source: 'source',
      dreams: 'Dream journal',
      noDreams: 'No dreams yet.',
      dreamNow: 'Dream now',
      dreaming: 'Dreaming…',
      narrative: 'Narrative',
      remembered: 'retained after waking',
      temp: 'temperature',
      model: 'generator',
      samples: 'Sampled fragments',
      moodShift: 'Mood shift',
      refresh: 'Refresh',
      forget: 'Forget',
      forgetTarget: 'Forget target',
      forgetFaded: 'faded episodes',
      forgetHabits: 'historical habits',
      forgetSkills: 'all instincts',
      forgetAll: 'everything',
      confirmForget: 'Forget this for good? This cannot be undone.',
      graph: 'Impression graph',
      noGraph: 'No associations yet. Folding and dreaming draw the edges.',
      legendEpisode: 'episode',
      legendHabit: 'habit',
      legendSkill: 'instinct',
      legendDream: 'dream',
      context: 'Injected context',
      contextNote: 'The exact XML appended to the system prompt before the latest step.',
      noContext: 'No context rendered yet; the next step generates it.',
      backend: 'storage',
      loading: 'Loading…',
      error: 'Error',
      close: 'Close',
      forgetDone: 'Forgotten',
      episodes: 'episodes',
      sessions: 'sessions',
      journal: 'Recent journal',
      noJournal: 'No journal entries yet.',
      sqlite: 'SQLite',
      json: 'JSON fallback',
      openPanel: 'Open the brain monitor',
      closePanel: 'Close',
      activeHabits: 'active',
      history: 'history',
      dreamAt: 'dreamed',
      contextRenderedAt: 'rendered',
      never: 'never',
      totalEpisodes: 'episodes',
      totalHabits: 'habits',
      totalSkills: 'instincts',
      totalDreams: 'dreams',
      distilled: 'distilled',
      purged: 'purged',
      batch: 'batch',
      sourceUser: 'user stated',
      sourceInferred: 'inferred',
      sourceDream: 'dream generated',
      parallel: 'Parallel windows',
      noParallel: 'No other active windows',
      archived: 'archived',
      archivedSkills: 'Archived instincts',
      dreamCacheNote: 'The full dream is for you only; the model sees the afterglow and reads the cache only when asked.',
      fallibilityAnchors: 'Memory slips',
      noFallibilityAnchors: 'No corrected slips yet',
      metaEvolution: 'Meta-evolution',
      noMetaEvolution: 'No evolution records yet',
      pendingProposals: 'Pending proposals',
      trialActive: 'in trial',
      metaNightmare: 'Failed evolution',
      contextMetabolism: 'Breathe metabolism',
      noContextMetabolism: 'Context pressure not measured yet',
      contextWaterline: 'waterline',
      contextPeak: 'peak',
      contextThresholds: 'thresholds',
      contextDehydrated: 'tools dehydrated',
      contextCollapsed: 'collapsed',
      contextOpenLoops: 'open loops',
      contextHandover: 'carryover',
      contextBatch: 'Batch collapses',
      cacheMonitor: 'KV cache savings',
      cacheHit: 'Brain KV hit ratio',
      cacheSaved: 'Saved today',
      cacheLow: 'low-hit streak',
      cacheAlert: 'Cache alert',
      cacheBatch: 'batch rounds',
      cacheTokens: 'tokens',
      voiceMirror: 'Voice mirror',
      voiceFamiliarity: 'familiarity',
      voiceAcquired: 'acquired words',
      voiceNotes: 'Sleep voice notes',
      voiceNoNotes: 'No new intuition yet; it grows from real conversation.',
      voiceMoments: 'Resonance moments',
      voiceNoMoments: 'No clear resonance moment yet',
      voiceHint: 'All grown from your real conversations; no canned lines. Frozen into Tier 1 after /dream.',
      voiceLevel: 'stage',
    };

    const CSS = `
.bionic-root { position: fixed; inset: 0; z-index: 80; pointer-events: none; }
.bionic-launcher { position: fixed; right: 22px; bottom: 96px; pointer-events: auto; display: flex; align-items: center; gap: 8px;
  padding: 8px 14px 8px 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); cursor: pointer;
  box-shadow: 0 8px 28px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent);
  font: inherit; font-size: 13px; }
.bionic-launcher:hover { border-color: var(--dsw-alias-brand-primary); }
.bionic-launcher-badge { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
  background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-size: 11px;
  display: inline-flex; align-items: center; justify-content: center; }
.bionic-panel { position: fixed; right: 16px; top: 72px; bottom: 96px; width: min(440px, 94vw); pointer-events: auto;
  display: flex; flex-direction: column; overflow: hidden; color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 16px; background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 18px 60px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent); }
.bionic-head { display: flex; align-items: flex-start; gap: 10px; padding: 14px 14px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.bionic-head-text { flex: 1; min-width: 0; }
.bionic-title { font-size: 15px; font-weight: 600; line-height: 1.25; }
.bionic-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
.bionic-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1); font-size: 10px; color: var(--dsw-alias-label-secondary); }
.bionic-chip-open { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.bionic-icon-btn { pointer-events: auto; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary); width: 26px; height: 26px; border-radius: 8px; cursor: pointer; font-size: 15px; line-height: 1; }
.bionic-icon-btn:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.bionic-tabs { display: flex; gap: 2px; padding: 8px 10px; overflow-x: auto; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.bionic-tab { flex: 0 0 auto; border: none; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 11.5px; padding: 5px 9px; border-radius: 8px; cursor: pointer; }
.bionic-tab:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.bionic-tab-on { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-brand-primary); font-weight: 600; }
.bionic-body { flex: 1; overflow-y: auto; padding: 12px 14px 16px; }
.bionic-foot { display: flex; gap: 6px; align-items: center; padding: 9px 12px; border-top: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); }
.bionic-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 11px; background: var(--dsw-alias-bg-layer-1);
  padding: 10px 11px; margin-bottom: 9px; }
.bionic-card-soft { background: var(--dsw-alias-bg-layer-2); }
.bionic-label { font-size: 10.5px; color: var(--dsw-alias-label-secondary); letter-spacing: .04em; text-transform: uppercase; }
.bionic-value { font-size: 12.5px; line-height: 1.55; margin-top: 3px; }
.bionic-muted { color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 1.55; }
.bionic-row { display: flex; align-items: center; gap: 6px; }
.bionic-between { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.bionic-quote { border-left: 2px solid var(--dsw-alias-brand-primary); padding-left: 8px; margin: 6px 0; font-size: 12px; line-height: 1.6; }
.bionic-bar { height: 4px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; margin-top: 6px; }
.bionic-bar-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); }
.bionic-tag { display: inline-flex; align-items: center; padding: 0 6px; border-radius: 5px; font-size: 10px;
  border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.bionic-tag-clear { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.bionic-tag-sum { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.bionic-tag-fade { color: var(--dsw-alias-state-idle-primary); border-color: var(--dsw-alias-state-idle-primary); }
.bionic-tag-active { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.bionic-btn { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 11.5px; padding: 5px 10px; border-radius: 8px; cursor: pointer; }
.bionic-btn:hover { border-color: var(--dsw-alias-brand-primary); }
.bionic-btn:disabled { opacity: .55; cursor: default; }
.bionic-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base); font-weight: 600; }
.bionic-select { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 11px; padding: 4px 6px; border-radius: 7px; }
.bionic-error { border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary);
  border-radius: 9px; padding: 7px 9px; font-size: 11.5px; margin-bottom: 9px; }
.bionic-pre { white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10.5px; line-height: 1.55; color: var(--dsw-alias-label-secondary); margin: 0; }
.bionic-details summary { cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 11px; margin-top: 6px; }
.bionic-list { margin: 4px 0 0; padding-left: 16px; }
.bionic-list li { margin: 3px 0; font-size: 12px; line-height: 1.55; }
.bionic-svg { width: 100%; height: auto; display: block; }
.bionic-legend { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.bionic-dot { width: 7px; height: 7px; border-radius: 999px; display: inline-block; margin-right: 4px; }
.bionic-empty { padding: 26px 10px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 12px; }
`;

    function makeT(ctx) {
      let bound = null;
      try {
        bound = ctx.locale.bind(NS);
      } catch {
        bound = null;
      }
      return (key) => {
        const value = bound ? bound(key) : key;
        return value === key ? (zh[key] ?? en[key] ?? key) : value;
      };
    }

    function useLocaleRevision(ctx) {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        if (!ctx.locale?.subscribe) return undefined;
        return ctx.locale.subscribe(() => force((value) => value + 1));
      }, [ctx]);
    }

    function useBionicData(active, intervalMs) {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState('');
      const load = React.useCallback(async () => {
        try {
          const response = await fetch('/dsh-bionic-memory/state', {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          const body = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
          if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
          setData(body);
          setError('');
        } catch (err) {
          setError(String(err?.message || err));
        }
      }, []);
      React.useEffect(() => {
        if (!active) return undefined;
        load();
        const id = setInterval(load, intervalMs || 15000);
        return () => clearInterval(id);
      }, [active, intervalMs, load]);
      return { data, error, setError, load };
    }

    async function postJson(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
      if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`);
      return payload;
    }

    function fmtTime(ts) {
      if (!ts) return '';
      try {
        return new Intl.DateTimeFormat(undefined, {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(new Date(ts));
      } catch {
        return String(ts);
      }
    }

    function BrainMark({ size }) {
      return h(
        'svg',
        { viewBox: '0 0 64 64', width: size || 18, height: size || 18, 'aria-hidden': true, style: { display: 'block' } },
        h(
          'g',
          { fill: 'none', stroke: 'currentColor', strokeWidth: 4, strokeLinecap: 'round' },
          h('path', {
            d: 'M32 47c-9 0-16-6.3-16-14.2C16 24 22.6 18 31 18c7 0 12.4 4.7 12.4 10.8 0 5.4-4.4 9.4-10 9.4-4.6 0-8.2-3-8.2-6.9 0-3.6 2.9-6.3 6.6-6.3 2.9 0 5.2 1.9 5.2 4.3',
          }),
        ),
        h('circle', { cx: 44.5, cy: 21, r: 3.2, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 19, cy: 42, r: 2.6, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 40, cy: 49, r: 2.2, fill: 'currentColor', stroke: 'none' }),
      );
    }

    function BandTag({ band, t }) {
      const cls = band === 'clear' ? 'bionic-tag bionic-tag-clear' : band === 'summarized' ? 'bionic-tag bionic-tag-sum' : 'bionic-tag bionic-tag-fade';
      return h('span', { className: cls }, t(band));
    }

    function SourceTag({ source, t }) {
      const label =
        source === 'user_stated' ? t('sourceUser') : source === 'dream_generated' ? t('sourceDream') : t('sourceInferred');
      const cls =
        source === 'user_stated'
          ? 'bionic-tag bionic-tag-active'
          : source === 'dream_generated'
            ? 'bionic-tag bionic-tag-sum'
            : 'bionic-tag bionic-tag-fade';
      return h('span', { className: cls }, label);
    }

    function Bar({ value, color }) {
      const width = Math.max(2, Math.min(100, Math.round((Number(value) || 0) * 100)));
      return h(
        'div',
        { className: 'bionic-bar' },
        h('div', { className: 'bionic-bar-fill', style: { width: `${width}%`, background: color } }),
      );
    }

    function Card({ label, extra, children, soft }) {
      return h(
        'div',
        { className: soft ? 'bionic-card bionic-card-soft' : 'bionic-card' },
        label || extra
          ? h(
              'div',
              { className: 'bionic-between' },
              label ? h('div', { className: 'bionic-label' }, label) : h('span'),
              extra || h('span'),
            )
          : null,
        children,
      );
    }

    function Empty({ text }) {
      return h('div', { className: 'bionic-empty' }, text);
    }

    function ScratchpadTab({ data, t }) {
      const scratchpad = data.scratchpad || {};
      const mood = scratchpad.mood || {};
      const stats = data.stats || {};
      return h(
        'div',
        null,
        h(
          Card,
          { label: t('mood'), extra: h('span', { className: 'bionic-chip' }, `${Math.round((mood.valence || 0) * 100)} / ${Math.round((mood.arousal || 0) * 100)}`) },
          h('div', { className: 'bionic-value' }, mood.label || t('unknown')),
          h('div', { className: 'bionic-label', style: { marginTop: 8 } }, t('valence')),
          h(Bar, { value: (Number(mood.valence) + 1) / 2 }),
          h('div', { className: 'bionic-label', style: { marginTop: 8 } }, t('arousal')),
          h(Bar, { value: Number(mood.arousal) || 0 }),
        ),
        h(
          Card,
          { label: t('dreamAfterglow'), extra: h('span', { className: 'bionic-chip' }, fmtTime(scratchpad.dream_at) || t('never')) },
          h('div', { className: 'bionic-quote' }, scratchpad.dream_afterglow || t('noAfterglow')),
        ),
        h(
          Card,
          { label: t('curiosity') },
          (scratchpad.curiosity_hooks || []).filter((hook) => !hook.resolved).length
            ? h(
                'ul',
                { className: 'bionic-list' },
                (scratchpad.curiosity_hooks || [])
                  .filter((hook) => !hook.resolved)
                  .slice(0, 5)
                  .map((hook) =>
                    h(
                      'li',
                      { key: hook.id },
                      hook.text,
                      h('span', { className: 'bionic-muted' }, ` · ${hook.age || fmtTime(hook.created_at)}`),
                    ),
                  ),
              )
            : h('div', { className: 'bionic-muted' }, t('noCuriosity')),
        ),
        h(
          'div',
          { className: 'bionic-row', style: { gap: 8 } },
          h(Card, { label: t('lastChat'), soft: true }, h('div', { className: 'bionic-value' }, stats.last_user_contact_at ? fmtTime(stats.last_user_contact_at) : t('never'))),
          h(Card, { label: t('lastDream'), soft: true }, h('div', { className: 'bionic-value' }, stats.last_dream_at ? fmtTime(stats.last_dream_at) : t('never'))),
        ),
        h(
          Card,
          { label: t('parallel') },
          (data.active_sessions || []).length
            ? h(
                'ul',
                { className: 'bionic-list' },
                (data.active_sessions || []).map((session) =>
                  h(
                    'li',
                    { key: session.session_id },
                    session.summary,
                    h('span', { className: 'bionic-muted' }, ` · ${session.age || fmtTime(session.updated_at)}`),
                  ),
                ),
              )
            : h('div', { className: 'bionic-muted' }, t('noParallel')),
        ),
        h(
          Card,
          { label: t('fallibilityAnchors') },
          (data.scratchpad?.fallibility_anchors || []).length
            ? h(
                'ul',
                { className: 'bionic-list' },
                (data.scratchpad?.fallibility_anchors || []).map((anchor) =>
                  h('li', { key: anchor.id }, anchor.text),
                ),
              )
            : h('div', { className: 'bionic-muted' }, t('noFallibilityAnchors')),
        ),
        h(
          Card,
          { label: t('metaEvolution') },
          data.meta_evolution
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'bionic-row' },
                  h('span', { className: 'bionic-chip' }, `prompt v${data.meta_evolution.prompt_version || 0}`),
                  h('span', { className: 'bionic-chip' }, `${(data.meta_evolution.trials || []).length} ${t('trialActive')}`),
                  h('span', { className: 'bionic-chip' }, `${(data.meta_evolution.pending_proposals || []).length} ${t('pendingProposals')}`),
                ),
                (data.meta_evolution.pending_proposals || []).length
                  ? h(
                      'ul',
                      { className: 'bionic-list' },
                      (data.meta_evolution.pending_proposals || []).slice(0, 3).map((proposal) =>
                        h('li', { key: proposal.id }, `${proposal.summary} → /evolve approve`),
                      ),
                    )
                  : null,
                data.meta_evolution.nightmare
                  ? h('div', { className: 'bionic-quote', style: { marginTop: 6 } },
                      `${t('metaNightmare')}：${data.meta_evolution.nightmare.text}`)
                  : null,
              )
            : h('div', { className: 'bionic-muted' }, t('noMetaEvolution')),
        ),
        h(
          Card,
          { label: t('contextMetabolism') },
          data.context_metabolism?.enabled
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'bionic-row', style: { flexWrap: 'wrap', gap: 4 } },
                  h('span', { className: 'bionic-chip' }, `${t('contextWaterline')} ${Math.round((data.context_metabolism.ratio || 0) * 100)}%`),
                  h('span', { className: 'bionic-chip' }, `${t('contextPeak')} ${Math.round((data.context_metabolism.peak_ratio || 0) * 100)}%`),
                  h(
                    'span',
                    { className: 'bionic-chip' },
                    `${t('contextThresholds')} ${Math.round((data.context_metabolism.thresholds?.batch || 0.82) * 100)} / ${Math.round((data.context_metabolism.thresholds?.prefix || 0.45) * 100)}`,
                  ),
                ),
                h(
                  'div',
                  { className: 'bionic-bar' },
                  h('div', {
                    className: 'bionic-bar-fill',
                    style: { width: `${Math.min(100, Math.round((data.context_metabolism.ratio || 0) * 100))}%` },
                  }),
                ),
                h(
                  'div',
                  { className: 'bionic-muted', style: { marginTop: 6 } },
                  `${t('contextBatch')} ${data.context_metabolism.batch?.count || 0} 次 · ${t('contextCollapsed')} ${
                    data.context_metabolism.collapsed
                      ? `${data.context_metabolism.collapsed.first_turn}-${data.context_metabolism.collapsed.last_turn}`
                      : '—'
                  } · ${t('contextOpenLoops')} ${(data.context_metabolism.open_loops || []).length}`,
                ),
                (data.context_metabolism.open_loops || []).length
                  ? h(
                      'ul',
                      { className: 'bionic-list' },
                      (data.context_metabolism.open_loops || []).slice(0, 3).map((loop) =>
                        h('li', { key: loop.id }, `${loop.text} → /context resolve ${loop.id}`),
                      ),
                    )
                  : null,
                data.context_metabolism.handover
                  ? h(
                      'div',
                      { className: 'bionic-muted', style: { marginTop: 4 } },
                      `${t('contextHandover')}：${data.context_metabolism.handover.minutes_ago} 分钟前 · ${data.context_metabolism.handover.emotion || ''}`,
                    )
                  : null,
              )
            : h('div', { className: 'bionic-muted' }, t('noContextMetabolism')),
        ),
        h(
          Card,
          { label: t('cacheMonitor') },
          data.meta_evolution?.cache
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'bionic-row', style: { flexWrap: 'wrap', gap: 4 } },
                  h(
                    'span',
                    { className: 'bionic-chip' },
                    `${t('cacheHit')} ${Math.round((data.meta_evolution.cache.today_hit_ratio || 0) * 100)}%`,
                  ),
                  h(
                    'span',
                    { className: 'bionic-chip' },
                    `${t('cacheSaved')} ${data.meta_evolution.cache.today_saved_tokens || 0} ${t('cacheTokens')}`,
                  ),
                  h(
                    'span',
                    { className: 'bionic-chip' },
                    `${t('cacheLow')} ${data.meta_evolution.cache.low_streak || 0}`,
                  ),
                  h(
                    'span',
                    { className: 'bionic-chip' },
                    `${t('cacheBatch')} ${data.meta_evolution.cache.today_batch_rounds || 0}`,
                  ),
                ),
                h(
                  'div',
                  { className: 'bionic-bar' },
                  h('div', {
                    className: 'bionic-bar-fill',
                    style: { width: `${Math.min(100, Math.round((data.meta_evolution.cache.today_hit_ratio || 0) * 100))}%` },
                  }),
                ),
                data.meta_evolution.cache.alert
                  ? h(
                      'div',
                      { className: 'bionic-quote', style: { marginTop: 6 } },
                      `${t('cacheAlert')}：${data.meta_evolution.cache.alert.hint}`,
                    )
                  : null,
              )
            : h('div', { className: 'bionic-muted' }, t('noContextMetabolism')),
        ),
        h(
          Card,
          { label: t('voiceMirror') },
          data.voice_engine
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'bionic-row', style: { flexWrap: 'wrap', gap: 4 } },
                  h(
                    'span',
                    { className: 'bionic-chip' },
                    `${t('voiceFamiliarity')} ${Math.round((data.voice_engine.familiarity?.score || 0) * 100)}%`,
                  ),
                  h(
                    'span',
                    { className: 'bionic-chip' },
                    `${t('voiceLevel')} ${data.voice_engine.familiarity?.level || '初识'}`,
                  ),
                  h(
                    'span',
                    { className: 'bionic-chip' },
                    `${t('voiceAcquired')} ${(data.voice_engine.acquired_vocabulary || []).length}`,
                  ),
                ),
                h(
                  'div',
                  { className: 'bionic-bar' },
                  h('div', {
                    className: 'bionic-bar-fill',
                    style: { width: `${Math.min(100, Math.round((data.voice_engine.familiarity?.score || 0) * 100))}%` },
                  }),
                ),
                (data.voice_engine.acquired_vocabulary || []).length
                  ? h(
                      'div',
                      { className: 'bionic-muted', style: { marginTop: 5 } },
                      `${t('voiceAcquired')}：${(data.voice_engine.acquired_vocabulary || []).map((entry) => `“${entry.word}”`).join('、')}`,
                    )
                  : null,
                h(
                  'div',
                  { className: 'bionic-muted', style: { marginTop: 5 } },
                  data.voice_engine.familiarity?.hint || '',
                ),
                (data.voice_engine.self_discovered_voice_notes || []).length
                  ? h(
                      'div',
                      { style: { marginTop: 6 } },
                      h('div', { className: 'bionic-muted' }, t('voiceNotes')),
                      h(
                        'ul',
                        { className: 'bionic-list' },
                        (data.voice_engine.self_discovered_voice_notes || []).map((note) =>
                          h('li', { key: note }, note),
                        ),
                      ),
                    )
                  : h('div', { className: 'bionic-muted', style: { marginTop: 5 } }, t('voiceNoNotes')),
                (data.voice_engine.organic_resonance_moments || []).length
                  ? h(
                      'div',
                      { style: { marginTop: 6 } },
                      h('div', { className: 'bionic-muted' }, t('voiceMoments')),
                      h(
                        'ul',
                        { className: 'bionic-list' },
                        (data.voice_engine.organic_resonance_moments || []).map((moment) =>
                          h(
                            'li',
                            { key: `${moment.at}-${moment.vibe}` },
                            `[${moment.vibe}] ${moment.user_msg} → ${moment.my_reply}`,
                          ),
                        ),
                      ),
                    )
                  : null,
                h('div', { className: 'bionic-muted', style: { marginTop: 5 } }, t('voiceHint')),
              )
            : h('div', { className: 'bionic-muted' }, t('noContextMetabolism')),
        ),
        h(
          Card,
          { label: t('journal') },
          (data.journal || []).length
            ? h(
                'ul',
                { className: 'bionic-list' },
                (data.journal || []).slice(0, 8).map((entry) =>
                  h(
                    'li',
                    { key: entry.seq },
                    h('span', { className: 'bionic-tag', style: { marginRight: 5 } }, entry.kind),
                    entry.summary,
                    h('span', { className: 'bionic-muted' }, ` · ${entry.age || fmtTime(entry.at)}`),
                  ),
                ),
              )
            : h('div', { className: 'bionic-muted' }, t('noJournal')),
        ),
      );
    }

    function EpisodesTab({ data, t }) {
      const episodes = data.working_memory || [];
      if (!episodes.length) return h(Empty, { text: t('noMemories') });
      return h(
        'div',
        null,
        episodes.map((episode) => {
          const text =
            episode.band === 'clear'
              ? episode.level_0_raw
              : episode.band === 'summarized'
                ? episode.level_1_summary
                : episode.level_2_impression;
          const color =
            episode.band === 'clear'
              ? 'var(--dsw-alias-state-success-primary)'
              : episode.band === 'summarized'
                ? 'var(--dsw-alias-state-warn-primary)'
                : 'var(--dsw-alias-state-idle-primary)';
          return h(
            Card,
            {
              key: episode.id,
              label: `${episode.age}`,
              extra: h(
                'div',
                { className: 'bionic-row' },
                episode.anchor ? h('span', { className: 'bionic-tag bionic-tag-active' }, '锚') : null,
                h(SourceTag, { source: episode.source_type, t }),
                h(BandTag, { band: episode.band, t }),
              ),
            },
            h('div', { className: 'bionic-value' }, text || episode.level_2_impression),
            h(Bar, { value: episode.retention, color }),
            h(
              'div',
              { className: 'bionic-muted', style: { marginTop: 5 } },
              `${t('retention')} ${Math.round((episode.retention || 0) * 100)}% · ${t('emotion')} ${episode.e} · ${t('surprise')} ${episode.n} · k=${episode.k}`,
            ),
            (episode.keywords || []).length
              ? h(
                  'div',
                  { className: 'bionic-row', style: { flexWrap: 'wrap', gap: 4, marginTop: 6 } },
                  (episode.keywords || []).slice(0, 6).map((keyword) => h('span', { key: keyword, className: 'bionic-tag' }, keyword)),
                )
              : null,
            h(
              'details',
              { className: 'bionic-details' },
              h('summary', null, 'L0 / L1 / L2'),
              h('div', { className: 'bionic-muted', style: { marginTop: 4 } }, `L0: ${episode.level_0_raw || '（已物理清空）'}`),
              h('div', { className: 'bionic-muted' }, `L1: ${episode.level_1_summary || '（已物理清空）'}`),
              h('div', { className: 'bionic-muted' }, `L2: ${episode.level_2_impression || ''}`),
            ),
          );
        }),
      );
    }

    function HabitsTab({ data, t }) {
      const habits = data.habits || [];
      if (!habits.length) return h(Empty, { text: t('noHabits') });
      return h(
        'div',
        null,
        habits.map((habit) => {
          const active = habit.status === 'active';
          const anchors = habit.exception_anchors || [];
          return h(
            Card,
            {
              key: habit.id,
              label: active ? t('activeHabits') : t('history'),
              extra: h(
              'div',
              { className: 'bionic-row' },
              h(SourceTag, { source: habit.source_type, t }),
              h('span', { className: active ? 'bionic-tag bionic-tag-active' : 'bionic-tag bionic-tag-fade' }, active ? t('active') : t('historical')),
            ),
            },
            h('div', { className: 'bionic-value' }, habit.pattern_summary),
            h('div', { className: 'bionic-muted', style: { marginTop: 4 } },
              `${habit.occurrence_count} ${t('occurrences')} · ${habit.age || fmtTime(habit.last_triggered)}`,
            ),
            h('div', { className: 'bionic-label', style: { marginTop: 8 } }, `${t('stability')} ${Math.round((habit.stability_score || 0) * 100)}%`),
            h(Bar, { value: habit.stability_score }),
            anchors.length
              ? h(
                  'div',
                  { style: { marginTop: 8 } },
                  h('div', { className: 'bionic-label' }, t('anchor')),
                  anchors.map((anchor) =>
                    h(
                      'div',
                      { key: anchor.episode_id || anchor.date, className: 'bionic-quote' },
                      `(${anchor.date}) ${anchor.brief}`,
                    ),
                  ),
                )
              : null,
          );
        }),
      );
    }

    function SkillsTab({ data, t }) {
      const skills = (data.skills || []).filter((skill) => skill.active);
      const archived = (data.archived_skills || []).slice(0, 12);
      if (!skills.length && !archived.length) return h(Empty, { text: t('noSkills') });
      return h(
        'div',
        null,
        skills.map((skill) =>
          h(
            Card,
            {
              key: skill.id,
              label: t('skills'),
              extra: h('span', { className: 'bionic-chip' }, `${t('confidence')} ${Math.round((skill.confidence || 0) * 100)}%`),
            },
            h('div', { className: 'bionic-value' }, skill.rule),
            h(Bar, { value: skill.confidence }),
            h(
              'div',
              { className: 'bionic-muted', style: { marginTop: 5 } },
              `${t('source')} ${skill.source || '—'} · ${fmtTime(skill.created_at)}`,
            ),
          ),
        ),
        archived.length
          ? h(
              'div',
              { style: { marginTop: 14 } },
              h('div', { className: 'bionic-label' }, `${t('archivedSkills')} (${archived.length})`),
              archived.map((skill) =>
                h(
                  Card,
                  {
                    key: skill.id,
                    label: t('archived'),
                    extra: h('span', { className: 'bionic-chip' }, `${t('confidence')} ${Math.round((skill.confidence || 0) * 100)}%`),
                  },
                  h('div', { className: 'bionic-muted' }, skill.rule),
                  h('div', { className: 'bionic-muted', style: { marginTop: 4 } }, skill.age || ''),
                ),
              ),
            )
          : null,
      );
    }

    function DreamsTab({ data, t }) {
      const dreams = data.dreams || [];
      return h(
        'div',
        null,
        h('div', { className: 'bionic-muted', style: { marginBottom: 8 } }, t('dreamCacheNote')),
        dreams.length
          ? dreams.map((dream, index) =>
              h(
                Card,
                {
                  key: dream.id,
                  label: `${index === 0 ? t('tabDreams') : ''} ${dream.age || ''}`.trim(),
                  extra: h('span', { className: 'bionic-chip' }, `${dream.trigger} · ${dream.model || 'local'}`),
                },
                h('div', { className: 'bionic-label' }, t('narrative')),
                h('div', { className: 'bionic-value', style: { marginBottom: 8 } }, dream.narrative),
                h('div', { className: 'bionic-label' }, t('dreamAfterglow')),
                h('div', { className: 'bionic-quote' }, dream.afterglow),
                h(
                  'div',
                  { className: 'bionic-muted', style: { marginTop: 6 } },
                  `${t('temp')} ${dream.temperature} · ${t('remembered')} ${Math.round((dream.remembered_fraction || 0) * 100)}% · ${t('dreamAt')} ${fmtTime(dream.started_at)}`,
                ),
                h(
                  'div',
                  { className: 'bionic-row', style: { flexWrap: 'wrap', gap: 4, marginTop: 6 } },
                  h('span', { className: 'bionic-tag' }, `${t('episodes')} ${dream.nrem?.episodes ?? 0}`),
                  h('span', { className: 'bionic-tag' }, `${t('sessions')} ${dream.nrem?.sessions ?? 0}`),
                  h('span', { className: 'bionic-tag' }, `folds ${dream.nrem?.collapsed ?? 0}`),
                  h('span', { className: 'bionic-tag' }, `skills +${dream.nrem?.skills_added ?? 0}`),
                  h('span', { className: 'bionic-tag' }, `${t('distilled')} ${dream.nrem?.impressions_rewritten ?? 0}`),
                  h('span', { className: 'bionic-tag' }, `${t('purged')} ${dream.nrem?.purged ?? 0}`),
                  h('span', { className: 'bionic-tag' }, `${t('batch')} ${dream.nrem?.batch === 'llm' ? 'LLM' : '2-stage'}`),
                ),
                (dream.samples || []).length
                  ? h(
                      'details',
                      { className: 'bionic-details' },
                      h('summary', null, t('samples')),
                      h(
                        'ul',
                        { className: 'bionic-list' },
                        (dream.samples || []).map((sample, sampleIndex) =>
                          h('li', { key: `${dream.id}-${sampleIndex}` }, `[${sample.kind}] ${sample.label || sample.id}`),
                        ),
                      ),
                    )
                  : null,
              ),
            )
          : h(Empty, { text: t('noDreams') }),
      );
    }

    function GraphTab({ data, t }) {
      const graph = data.graph || { nodes: [], edges: [] };
      if (!graph.nodes.length) return h(Empty, { text: t('noGraph') });
      const nodes = graph.nodes.slice(0, 24);
      const index = new Map(nodes.map((node, position) => [node.id, position]));
      const cx = 170;
      const cy = 118;
      const rx = 132;
      const ry = 92;
      const positions = new Map();
      nodes.forEach((node, position) => {
        const angle = (Math.PI * 2 * position) / nodes.length - Math.PI / 2;
        positions.set(node.id, {
          x: cx + Math.cos(angle) * rx,
          y: cy + Math.sin(angle) * ry,
          node,
        });
      });
      const kindColor = (kind) =>
        kind === 'episode'
          ? 'var(--dsw-alias-brand-primary)'
          : kind === 'habit'
            ? 'var(--dsw-alias-state-warn-primary)'
            : kind === 'skill'
              ? 'var(--dsw-alias-state-success-primary)'
              : 'var(--dsw-alias-label-secondary)';
      return h(
        'div',
        null,
        h(
          'svg',
          { viewBox: '0 0 340 240', className: 'bionic-svg', role: 'img', 'aria-label': t('graph') },
          graph.edges.map((edge, position) => {
            const from = positions.get(edge.source);
            const to = positions.get(edge.target);
            if (!from || !to) return null;
            return h('line', {
              key: `e${position}`,
              x1: from.x,
              y1: from.y,
              x2: to.x,
              y2: to.y,
              stroke: 'var(--dsw-alias-border-l2)',
              strokeWidth: 0.7 + Math.min(1.6, (edge.weight || 0.4) * 1.6),
              opacity: 0.75,
            });
          }),
          nodes.map((node) => {
            const position = positions.get(node.id);
            if (!position) return null;
            const radius = 3.2 + Math.min(5, (node.weight || 0.3) * 5);
            return h(
              'g',
              { key: node.id },
              h('circle', { cx: position.x, cy: position.y, r: radius, fill: kindColor(node.kind) }),
              h(
                'title',
                null,
                `${node.kind}: ${node.label}`,
              ),
              h(
                'text',
                {
                  x: position.x,
                  y: position.y - radius - 3.5,
                  textAnchor: 'middle',
                  fontSize: 6.6,
                  fill: 'var(--dsw-alias-label-secondary)',
                },
                String(node.label || '').slice(0, 12),
              ),
            );
          }),
        ),
        h(
          'div',
          { className: 'bionic-legend' },
          h('span', null, h('i', { className: 'bionic-dot', style: { background: 'var(--dsw-alias-brand-primary)' } }), t('legendEpisode')),
          h('span', null, h('i', { className: 'bionic-dot', style: { background: 'var(--dsw-alias-state-warn-primary)' } }), t('legendHabit')),
          h('span', null, h('i', { className: 'bionic-dot', style: { background: 'var(--dsw-alias-state-success-primary)' } }), t('legendSkill')),
          h('span', null, h('i', { className: 'bionic-dot', style: { background: 'var(--dsw-alias-label-secondary)' } }), t('legendDream')),
        ),
      );
    }

    function ContextTab({ data, t }) {
      if (!data.context_preview) return h(Empty, { text: t('noContext') });
      return h(
        'div',
        null,
        h('div', { className: 'bionic-muted', style: { marginBottom: 8 } }, t('contextNote')),
        h(
          'div',
          { className: 'bionic-muted', style: { marginBottom: 6 } },
          `${t('contextRenderedAt')} ${data.context_render_at ? fmtTime(data.context_render_at) : '—'}`,
        ),
        h('pre', { className: 'bionic-pre' }, data.context_preview),
      );
    }

    function BrainPanel({ t, onClose, data, error, load }) {
      const [tab, setTab] = React.useState('scratchpad');
      const [busy, setBusy] = React.useState('');
      const [forgetTarget, setForgetTarget] = React.useState('faded');
      const [actionError, setActionError] = React.useState('');

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [onClose]);

      const dream = async () => {
        setBusy('dream');
        setActionError('');
        try {
          await postJson('/dsh-bionic-memory/dream', {});
          setTab('dreams');
          await load();
        } catch (err) {
          setActionError(String(err?.message || err));
        } finally {
          setBusy('');
        }
      };

      const forget = async () => {
        if (!window.confirm(t('confirmForget'))) return;
        setBusy('forget');
        setActionError('');
        try {
          const body = { target: forgetTarget };
          if (forgetTarget === 'all') body.confirm = 'all';
          await postJson('/dsh-bionic-memory/forget', body);
          await load();
        } catch (err) {
          setActionError(String(err?.message || err));
        } finally {
          setBusy('');
        }
      };

      const tabs = [
        ['scratchpad', t('tabScratchpad')],
        ['episodes', t('tabEpisodes')],
        ['habits', t('tabHabits')],
        ['skills', t('tabSkills')],
        ['dreams', t('tabDreams')],
        ['graph', t('tabGraph')],
        ['context', t('tabContext')],
      ];

      let body = null;
      if (!data) {
        body = h(Empty, { text: error ? `${t('error')}: ${error}` : t('loading') });
      } else if (tab === 'scratchpad') {
        body = h(ScratchpadTab, { data, t });
      } else if (tab === 'episodes') {
        body = h(EpisodesTab, { data, t });
      } else if (tab === 'habits') {
        body = h(HabitsTab, { data, t });
      } else if (tab === 'skills') {
        body = h(SkillsTab, { data, t });
      } else if (tab === 'dreams') {
        body = h(DreamsTab, { data, t });
      } else if (tab === 'graph') {
        body = h(GraphTab, { data, t });
      } else {
        body = h(ContextTab, { data, t });
      }

      const stats = data?.stats || {};
      return h(
        'section',
        { className: 'bionic-panel', role: 'dialog', 'aria-label': t('title') },
        h(
          'header',
          { className: 'bionic-head' },
          h('span', { style: { color: 'var(--dsw-alias-brand-primary)', marginTop: 2 } }, h(BrainMark, { size: 22 })),
          h(
            'div',
            { className: 'bionic-head-text' },
            h('div', { className: 'bionic-title' }, t('title')),
            h(
              'div',
              { className: 'bionic-sub' },
              `${t('subtitle')} · ${data ? (data.backend === 'sqlite' ? t('sqlite') : t('json')) : '—'}`,
            ),
          ),
          h('button', { className: 'bionic-icon-btn', onClick: onClose, 'aria-label': t('close'), title: t('close') }, '×'),
        ),
        h(
          'div',
          { className: 'bionic-tabs', role: 'tablist' },
          tabs.map(([id, label]) =>
            h(
              'button',
              {
                key: id,
                role: 'tab',
                'aria-selected': tab === id,
                className: tab === id ? 'bionic-tab bionic-tab-on' : 'bionic-tab',
                onClick: () => setTab(id),
              },
              label,
            ),
          ),
        ),
        h(
          'div',
          { className: 'bionic-body' },
          error && data ? h('div', { className: 'bionic-error' }, `${t('error')}: ${error}`) : null,
          actionError ? h('div', { className: 'bionic-error' }, actionError) : null,
          data
            ? h(
                'div',
                { className: 'bionic-row', style: { flexWrap: 'wrap', gap: 5, marginBottom: 10 } },
                h('span', { className: 'bionic-chip bionic-chip-open' }, `${t('totalEpisodes')} ${stats.episodes || 0}`),
                h('span', { className: 'bionic-chip' }, `${t('totalHabits')} ${stats.habits_active || 0}`),
                h('span', { className: 'bionic-chip' }, `${t('totalSkills')} ${stats.skills_active || 0}`),
                h('span', { className: 'bionic-chip' }, `${t('totalDreams')} ${stats.dreams || 0}`),
                h('span', { className: 'bionic-chip' }, `${t('sessions')} ${stats.sessions || 0}`),
              )
            : null,
          body,
        ),
        h(
          'footer',
          { className: 'bionic-foot' },
          h('button', { className: 'bionic-btn', onClick: () => load(), disabled: !!busy }, t('refresh')),
          h('button', { className: 'bionic-btn bionic-btn-primary', onClick: dream, disabled: !!busy }, busy === 'dream' ? t('dreaming') : t('dreamNow')),
          h('span', { style: { flex: 1 } }),
          h(
            'select',
            {
              className: 'bionic-select',
              value: forgetTarget,
              onChange: (event) => setForgetTarget(event.target.value),
              'aria-label': t('forgetTarget'),
            },
            h('option', { value: 'faded' }, t('forgetFaded')),
            h('option', { value: 'habits' }, t('forgetHabits')),
            h('option', { value: 'skills' }, t('forgetSkills')),
            h('option', { value: 'all' }, t('forgetAll')),
          ),
          h('button', { className: 'bionic-btn', onClick: forget, disabled: !!busy }, t('forget')),
        ),
      );
    }

    function BrainOverlay({ ctx, t }) {
      const [open, setOpen] = React.useState(false);
      const { data, error, load } = useBionicData(true, 15000);
      const close = React.useCallback(() => setOpen(false), []);
      const episodes = data?.stats?.episodes ?? 0;
      return h(
        'div',
        { className: 'bionic-root' },
        h('style', null, CSS),
        !open
          ? h(
              'button',
              {
                className: 'bionic-launcher',
                onClick: () => setOpen(true),
                'aria-label': t('openPanel'),
                title: t('openPanel'),
              },
              h(BrainMark, { size: 18 }),
              h('span', null, t('launcher')),
              h('span', { className: 'bionic-launcher-badge' }, String(episodes)),
            )
          : null,
        open ? h(BrainPanel, { t, onClose: close, data, error, load }) : null,
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const disposers = [];
          try {
            disposers.push(ctx.locale.register(NS, 'en', en));
          } catch (error) {
            console.warn('[bionic-memory] locale en registration failed', error);
          }
          try {
            disposers.push(ctx.locale.register(NS, 'zh', zh));
          } catch (error) {
            console.warn('[bionic-memory] locale zh registration failed', error);
          }
          return () => {
            for (const dispose of disposers) {
              try {
                dispose();
              } catch {
                /* already removed */
              }
            }
          };
        }, 'bionic-memory: dictionaries');

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'bionic-memory',
              order: 25,
              label: () => 'Bionic memory',
            },
            function BionicMemorySeat() {
              useLocaleRevision(ctx);
              const t = makeT(ctx);
              return h(BrainOverlay, { ctx, t });
            },
          ),
        );
      },
    };
  },
});
