<script lang="ts">
  let { event }: { event: string } = $props();

  const TAG_STYLES: Record<string, { bg: string; fg: string }> = {
    'node:enter': { bg: 'var(--tag-enter-bg)', fg: 'var(--tag-enter-fg)' },
    'node:exit': { bg: 'var(--tag-exit-bg)', fg: 'var(--tag-exit-fg)' },
    'node:error': { bg: 'var(--tag-exit-fail-bg)', fg: 'var(--tag-exit-fail-fg)' },
    'agent:thinking': { bg: 'var(--tag-thinking-bg)', fg: 'var(--tag-thinking-fg)' },
    'agent:text': { bg: 'var(--tag-text-bg)', fg: 'var(--tag-text-fg)' },
    'agent:tool_use': { bg: 'var(--tag-tool-bg)', fg: 'var(--tag-tool-fg)' },
    'agent:response': { bg: 'var(--tag-response-bg)', fg: 'var(--tag-response-fg)' },
    'agent:error': { bg: 'var(--tag-exit-fail-bg)', fg: 'var(--tag-exit-fail-fg)' },
    'agent:prompt': { bg: 'var(--tag-text-bg)', fg: 'var(--tag-text-fg)' },
    'agent:message': { bg: 'var(--tag-text-bg)', fg: 'var(--tag-text-fg)' },
    'agent:tool_progress': { bg: 'var(--tag-tool-bg)', fg: 'var(--tag-tool-fg)' },
    'agent:init': { bg: 'var(--tag-text-bg)', fg: 'var(--tag-text-fg)' },
    'agent:status': { bg: 'var(--tag-text-bg)', fg: 'var(--tag-text-fg)' },
    'blackboard:read': { bg: 'var(--tag-bb-bg)', fg: 'var(--tag-bb-fg)' },
    'blackboard:write': { bg: 'var(--tag-bb-bg)', fg: 'var(--tag-bb-fg)' },
    'strategy:decision': { bg: 'var(--tag-thinking-bg)', fg: 'var(--tag-thinking-fg)' },
    'tree:tick': { bg: 'var(--tag-exit-bg)', fg: 'var(--tag-exit-fg)' },
    'tree:reset': { bg: 'var(--tag-text-bg)', fg: 'var(--tag-text-fg)' },
    'tree:abort': { bg: 'var(--tag-exit-fail-bg)', fg: 'var(--tag-exit-fail-fg)' },
  };

  let style = $derived(TAG_STYLES[event] ?? { bg: 'var(--bg-hover)', fg: 'var(--text-muted)' });
</script>

<span class="event-tag" style:background={style.bg} style:color={style.fg}>{event}</span>

<style>
  .event-tag {
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 500;
    padding: 2px 7px;
    border-radius: 4px;
    white-space: nowrap;
  }
</style>
