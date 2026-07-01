import type { CSSProperties } from 'react';
import { useState, type JSX } from 'react';
import { ListTodo, Play, FolderGit2, Settings, CircleDot, GitPullRequest } from 'lucide-react';
import { Button } from '@beaver/ui/components/ui/button';
import { Badge } from '@beaver/ui/components/ui/badge';
import { Separator } from '@beaver/ui/components/ui/separator';
import { ScrollArea } from '@beaver/ui/components/ui/scroll-area';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@beaver/ui/components/ui/resizable';
import { cn } from '@beaver/ui/lib/utils';

const DRAG: CSSProperties = { WebkitAppRegion: 'drag' } as CSSProperties;
const NO_DRAG: CSSProperties = { WebkitAppRegion: 'no-drag' } as CSSProperties;

type NavKey = 'tasks' | 'runs' | 'repos';
const NAV: { key: NavKey; label: string; icon: typeof ListTodo }[] = [
  { key: 'tasks', label: 'Tasks', icon: ListTodo },
  { key: 'runs', label: 'Runs', icon: Play },
  { key: 'repos', label: 'Repos', icon: FolderGit2 }
];

// Placeholder rows until the daemon run/task feed is wired.
type RunStatus = 'implementing' | 'verifying' | 'pr_ready' | 'blocked_tests';
const SAMPLE: { id: string; title: string; status: RunStatus }[] = [
  { id: 'PROJ-101', title: 'Add provider abstraction to the agent runner', status: 'pr_ready' },
  { id: 'PROJ-102', title: 'Resumable SSE cursor for the run stream', status: 'implementing' },
  { id: 'PROJ-103', title: 'Crash-recovery on daemon restart', status: 'verifying' },
  { id: 'PROJ-104', title: 'Lark base task source sync', status: 'blocked_tests' }
];

const STATUS_LABEL: Record<RunStatus, string> = {
  implementing: 'Implementing',
  verifying: 'Verifying',
  pr_ready: 'PR ready',
  blocked_tests: 'Blocked · tests'
};

function StatusBadge({ status }: { status: RunStatus }): JSX.Element {
  const variant = status === 'pr_ready' ? 'default' : status === 'blocked_tests' ? 'destructive' : 'secondary';
  return <Badge variant={variant}>{STATUS_LABEL[status]}</Badge>;
}

export function App(): JSX.Element {
  const [nav, setNav] = useState<NavKey>('tasks');
  const [selected, setSelected] = useState(SAMPLE[0]?.id ?? '');
  const active = SAMPLE.find((r) => r.id === selected) ?? SAMPLE[0];

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Drag toolbar; leaves room for the macOS traffic lights. */}
      <div className="flex h-12 shrink-0 items-center border-b pl-20 pr-3" style={DRAG}>
        <span className="text-sm font-semibold tracking-tight">Beaver</span>
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
                onClick={() => void window.beaver?.preferences.open()}
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
              {SAMPLE.map((run) => (
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
                    <span className="font-mono text-xs text-muted-foreground">{run.id}</span>
                    <StatusBadge status={run.status} />
                  </div>
                  <span className="text-sm">{run.title}</span>
                </button>
              ))}
            </div>
          </ScrollArea>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={48} minSize={30}>
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <CircleDot className="size-4 text-muted-foreground" />
              <span className="font-mono text-xs text-muted-foreground">{active?.id}</span>
              <span className="truncate text-sm font-medium">{active?.title}</span>
              {active && <StatusBadge status={active.status} />}
            </div>
            <ScrollArea className="flex-1">
              <div className="flex flex-col gap-3 p-4 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <GitPullRequest className="size-4" />
                  Run stream will render here (agent.text / tool_use / handoff diff over the SSE cursor).
                </div>
              </div>
            </ScrollArea>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
