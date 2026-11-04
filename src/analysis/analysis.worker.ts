import { tasks, type TaskName } from './tasks';

self.onmessage = (e: MessageEvent<{ id: number; name: TaskName; args: never }>) => {
  const { id, name, args } = e.data;
  try {
    const result = (tasks[name] as (a: never, p: (f: number) => void) => unknown)(args, (f) => (self as unknown as Worker).postMessage({ id, progress: f }));
    (self as unknown as Worker).postMessage({ id, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
