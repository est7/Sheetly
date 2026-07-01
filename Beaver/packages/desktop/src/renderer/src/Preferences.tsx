import type { CSSProperties, JSX } from 'react';
import { useEffect, useState } from 'react';
import type { BeaverConfig } from '@beaver/core';
import { Button } from '@beaver/ui/components/ui/button';
import { Input } from '@beaver/ui/components/ui/input';
import { Label } from '@beaver/ui/components/ui/label';
import { Separator } from '@beaver/ui/components/ui/separator';
import { ScrollArea } from '@beaver/ui/components/ui/scroll-area';

const DRAG: CSSProperties = { WebkitAppRegion: 'drag' } as CSSProperties;

/**
 * Preferences window. Reads/writes the real BeaverConfig via the daemon
 * (config get/set); the daemon validates on save and returns a typed error the
 * form surfaces. Edits a safe scalar subset plus the default agent profile.
 */
export function Preferences(): JSX.Element {
  const [config, setConfig] = useState<BeaverConfig | null>(null);
  const [status, setStatus] = useState<{ kind: 'idle' | 'saved' | 'error'; message?: string }>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.beaver.config.get().then((result) => {
      if (result.ok) {
        setConfig(result.data);
      } else {
        setStatus({ kind: 'error', message: result.error });
      }
    });
  }, []);

  if (!config) {
    return (
      <Shell>
        <p className="p-6 text-sm text-muted-foreground">
          {status.kind === 'error' ? status.message : 'Loading configuration…'}
        </p>
      </Shell>
    );
  }

  const profileName = config.defaultAgentProfile;
  const profile = config.agentProfiles[profileName];

  const patch = (next: Partial<BeaverConfig>): void => {
    setConfig({ ...config, ...next });
    setStatus({ kind: 'idle' });
  };

  const patchProfile = (next: Partial<NonNullable<typeof profile>>): void => {
    if (!profile) return;
    setConfig({ ...config, agentProfiles: { ...config.agentProfiles, [profileName]: { ...profile, ...next } } });
    setStatus({ kind: 'idle' });
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    const result = await window.beaver.config.set(config);
    setSaving(false);
    if (result.ok) {
      setConfig(result.data);
      setStatus({ kind: 'saved' });
    } else {
      setStatus({ kind: 'error', message: result.error });
    }
  };

  return (
    <Shell>
      <ScrollArea className="flex-1">
        <div className="mx-auto flex max-w-lg flex-col gap-6 p-6">
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold">Workspace</h2>
            <Field label="Workspace root" htmlFor="workspaceRoot">
              <Input
                id="workspaceRoot"
                value={config.workspaceRoot}
                onChange={(e) => patch({ workspaceRoot: e.target.value })}
              />
            </Field>
            <Field label="Default repo path" htmlFor="defaultRepoPath">
              <Input
                id="defaultRepoPath"
                value={config.defaultRepoPath}
                onChange={(e) => patch({ defaultRepoPath: e.target.value })}
              />
            </Field>
            <Field label="Max concurrent runs" htmlFor="maxRuns">
              <Input
                id="maxRuns"
                type="number"
                min={1}
                value={config.maxConcurrentRuns}
                onChange={(e) => patch({ maxConcurrentRuns: Number(e.target.value) })}
              />
            </Field>
            <Field label="Git binary" htmlFor="gitBinary">
              <Input id="gitBinary" value={config.gitBinary} onChange={(e) => patch({ gitBinary: e.target.value })} />
            </Field>
          </section>

          <Separator />

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold">Default agent · {profileName}</h2>
            {profile ? (
              <>
                <Field label="Provider" htmlFor="provider">
                  <Input
                    id="provider"
                    placeholder="claude-code | pi | codex | (blank = generic)"
                    value={profile.provider ?? ''}
                    onChange={(e) =>
                      patchProfile({ provider: (e.target.value || undefined) as typeof profile.provider })
                    }
                  />
                </Field>
                <Field label="Executable" htmlFor="command">
                  <Input id="command" value={profile.command} onChange={(e) => patchProfile({ command: e.target.value })} />
                </Field>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                No profile named “{profileName}” is defined; add one in the config file.
              </p>
            )}
          </section>

          <div className="flex items-center justify-end gap-3">
            {status.kind === 'saved' && <span className="text-xs text-muted-foreground">Saved.</span>}
            {status.kind === 'error' && <span className="text-xs text-destructive">{status.message}</span>}
            <Button variant="ghost" onClick={() => window.close()}>
              Close
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </ScrollArea>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <div className="flex h-11 shrink-0 items-center border-b pl-20" style={DRAG}>
        <span className="text-sm font-semibold">Preferences</span>
      </div>
      {children}
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
