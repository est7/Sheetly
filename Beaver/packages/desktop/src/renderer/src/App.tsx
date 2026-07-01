import type { CSSProperties, JSX } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ListTodo, Play, FolderGit2, Settings, CircleDot, Wifi, WifiOff } from 'lucide-react';
import type { Run, RunEvent } from '@beaver/core';
import { Button } from '@beaver/ui/components/ui/button';
import { Badge } from '@beaver/ui/components/ui/badge';
import { Separator } from '@beaver/ui/components/ui/separator';
import { ScrollArea } from '@beaver/ui/components/ui/scroll-area';
import { Empty } from '@beaver/ui/components/ui/empty';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@beaver/ui/components/ui/resizable';
import { cn } from '@beaver/ui/lib/utils';

const DRAG: CSSProperties = { WebkitAppRegion: 'drag' } as CSSProperties;
const NO_DRAG: CSSProperties = { WebkitAppRegion: 'no-drag' } as CSSProperties;

type NavKey = 'runs' | 'repos';
const NAV: { key: NavKey; label: string; icon: typeof ListTodo }[] = [
  { key: 'runs', label: 'Runs', icon: Play },
  { key: 'repos', label: 'Repos', icon: FolderGit2 }
];

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' {
  if (status === 'pr_ready') return 'default';
  if (status.startsWith('blocked_') || status === 'aborted') return 'destructive';
  return 'secondary';
}

/** One-line summary of a run event for the stream pane. */
function describeEvent(event: RunEvent): string {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'agent.text':
    case 'agent.thinking':
      return String(p.content ?? '');
    case 'agent.tool_use':
      return `→ ${String(p.tool ?? 'tool')}`;
    case 'agent.tool_result':
      return `✓ ${String(p.tool ?? 'tool')}`;
    case 'run.status_changed':
      return `${String(p.from ?? '?')} → ${String(p.to ?? '?')}`;
    case 'agent.stderr':
      return String(p.line ?? '');
    default:
      return event.type;
  }
}

/** Merge events into a by-id map so the snapshot backlog and the live stream
 * can overlap without loss or duplication (D19 seq is monotonic per run). */
function mergeEvents(base: Map<string, RunEvent>, incoming: RunEvent[]): Map<string, RunEvent> {
  if (incoming.length === 0) return base;
  const next = new Map(base);
  for (const event of incoming) {
    next.set(event.id, event);
  }
  return next;
}

export function App(): JSX.Element {
  const [nav, setNav] = useState<NavKey>('runs');
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<string>('');
  // All runs' events, keyed by id; the pane filters to the selected run. A
  // global buffer means live events are never dropped for an unselected run.
  const [eventsById, setEventsById] = useState<Map<string, RunEvent>>(new Map());
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>('');

  const refreshRuns = useCallback(async () => {
    const result = await window.beaver.runs.list();
    if (result.ok) {
      setRuns(result.data);
      setError('');
      setSelected((current) => current || result.data[0]?.id || '');
    } else {
      setError(result.error);
    }
  }, []);

  // Initial load + live subscriptions.
  useEffect(() => {
    void refreshRuns();
    const offStatus = window.beaver.stream.onStatus(setConnected);
    const offEvent = window.beaver.stream.onEvent((event) => {
      setEventsById((prev) => mergeEvents(prev, [event]));
      if (event.type === 'run.status_changed' || event.type === 'run.created') {
        void refreshRuns();
      }
    });
    return () => {
      offStatus();
      offEvent();
    };
  }, [refreshRuns]);

  // Load the event backlog for the selected run; merged (not replaced) so live
  // events that arrived first survive.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    void window.beaver.runs.events(selected).then((result) => {
      if (!cancelled && result.ok) {
        setEventsById((prev) => mergeEvents(prev, result.data));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const active = useMemo(() => runs.find((r) => r.id === selected), [runs, selected]);
  const events = useMemo(
    () =>
      [...eventsById.values()]
        .filter((e) => e.runId === selected)
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)),
    [eventsById, selected]
  );

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <div className="flex h-12 shrink-0 items-center justify-between border-b pl-20 pr-3" style={DRAG}>
        <span className="text-sm font-semibold tracking-tight">Beaver</span>
        <span
          className="flex items-center gap-1 text-xs text-muted-foreground"
          title={connected ? 'Connected to daemon' : 'Daemon not connected'}
        >
          {connected ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
        </span>
      </div>

      <ResizablePanelGroup orientation="horizontal" className="flex-1">
        <ResizablePanel defaultSize={18} minSize={12} maxSize={28}>
          <div className="flex h-full flex-col gap-1 p-2">
            {NAV.map((item) => (
              <Button
                key={item.key}
                variant={nav === item.key ? 'secondary' : 'ghost'}
                className="justify-start gap-2"
                style={NO_DRAG}
                onClick={() => setNav(item.key)}
              >
                <item.icon className="size-4" />
                {item.label}
              </Button>
            ))}
            <div className="mt-auto">
              <Separator className="my-2" />
              <Button
                variant="ghost"
                className="w-full justify-start gap-2"
                style={NO_DRAG}
                onClick={() => void window.beaver.preferences.open()}
              >
                <Settings className="size-4" />
                Preferences
              </Button>
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={34} minSize={24}>
          <ScrollArea className="h-full">
            <div className="flex flex-col p-2">
              {runs.length === 0 ? (
                <Empty className="mt-16">{error || 'No runs yet'}</Empty>
              ) : (
                runs.map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => setSelected(run.id)}
                    className={cn(
                      'flex flex-col gap-1 rounded-lg border border-transparent px-3 py-2 text-left transition-colors hover:bg-muted',
                      selected === run.id && 'border-border bg-muted'
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-xs text-muted-foreground">{run.taskId}</span>
                      <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
                    </div>
                    <span className="truncate text-sm">{run.branchName}</span>
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={48} minSize={30}>
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <CircleDot className="size-4 text-muted-foreground" />
              {active ? (
                <>
                  <span className="font-mono text-xs text-muted-foreground">{active.taskId}</span>
                  <span className="truncate text-sm font-medium">{active.branchName}</span>
                  <Badge variant={statusVariant(active.status)}>{active.status}</Badge>
                </>
              ) : (
                <span className="text-sm text-muted-foreground">Select a run</span>
              )}
            </div>
            <ScrollArea className="flex-1">
              <div className="flex flex-col gap-1.5 p-4 font-mono text-xs">
                {events.length === 0 ? (
                  <span className="text-muted-foreground">No events yet.</span>
                ) : (
                  events.map((event) => (
                    <div key={event.id} className="flex gap-2">
                      <span className="shrink-0 text-muted-foreground/60">{event.type}</span>
                      <span className="whitespace-pre-wrap break-words">{describeEvent(event)}</span>
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
