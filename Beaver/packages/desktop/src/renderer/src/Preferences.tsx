import type { CSSProperties, JSX } from 'react';
import { Button } from '@beaver/ui/components/ui/button';
import { Input } from '@beaver/ui/components/ui/input';
import { Label } from '@beaver/ui/components/ui/label';
import { Separator } from '@beaver/ui/components/ui/separator';
import { ScrollArea } from '@beaver/ui/components/ui/scroll-area';

const DRAG: CSSProperties = { WebkitAppRegion: 'drag' } as CSSProperties;

/**
 * Preferences window shell. Fields map to BeaverConfig and will read/write via
 * the daemon's config get/set (CLI-first) once IPC is wired; today they are the
 * static layout so the window slot exists.
 */
export function Preferences(): JSX.Element {
  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <div className="flex h-11 shrink-0 items-center border-b pl-20" style={DRAG}>
        <span className="text-sm font-semibold">Preferences</span>
      </div>
      <ScrollArea className="flex-1">
        <div className="mx-auto flex max-w-lg flex-col gap-6 p-6">
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold">Workspace</h2>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="workspaceRoot">Workspace root</Label>
              <Input id="workspaceRoot" placeholder="~/.beaver/workspaces" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="maxRuns">Max concurrent runs</Label>
              <Input id="maxRuns" type="number" defaultValue={2} />
            </div>
          </section>

          <Separator />

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold">Default agent</h2>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="provider">Provider</Label>
              <Input id="provider" placeholder="claude-code | pi | codex | (generic)" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="command">Executable</Label>
              <Input id="command" placeholder="claude" />
            </div>
          </section>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => window.close()}>
              Close
            </Button>
            <Button disabled>Save</Button>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
