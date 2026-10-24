import { posix } from 'node:path';
import { PathJailError } from '@auto-wp/contracts';

export function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root === '/' ? '/' : `${root}/`);
}

function clean(p: string): string {
  const n = posix.normalize(p);
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

export interface JailDeps {
  wpRoot: string;
  outsideDocrootDir(): string | undefined;
  /** Real path of an existing path, or null when it does not exist. */
  realpath(path: string): Promise<string | null>;
}

export interface ResolvedPath {
  /** Normalised absolute path as requested (symlinks not resolved). */
  lexical: string;
  /** Path to operate on: symlinks in all parents (and the last component when followed) resolved. */
  real: string;
}

export class PathJail {
  private rootCache = new Map<string, string>();

  constructor(private readonly deps: JailDeps) {}

  private roots(): string[] {
    const out = [clean(this.deps.wpRoot)];
    const o = this.deps.outsideDocrootDir();
    if (o) out.push(clean(o));
    return out;
  }

  private async realRoots(): Promise<string[]> {
    const all: string[] = [];
    for (const r of this.roots()) {
      all.push(r);
      let real = this.rootCache.get(r);
      if (real === undefined) {
        real = (await this.deps.realpath(r)) ?? r;
        this.rootCache.set(r, real);
      }
      all.push(clean(real));
    }
    return all;
  }

  lexicalResolve(input: string): string {
    if (input.includes('\0')) throw new PathJailError('path contains a NUL byte');
    if (input === '') throw new PathJailError('empty path');
    const abs = input.startsWith('/') ? clean(input) : clean(posix.join(this.deps.wpRoot, input));
    if (!this.roots().some((r) => isInside(abs, r))) {
      throw new PathJailError(`path outside allowed roots: ${input}`);
    }
    return abs;
  }

  /** `followLast=false` leaves a final symlink unresolved (for lstat/remove/rename). */
  async resolve(input: string, followLast = true): Promise<ResolvedPath> {
    const lexical = this.lexicalResolve(input);
    const target = followLast ? lexical : posix.dirname(lexical);
    const realTarget = await this.realpathExisting(target);
    const real = followLast ? realTarget : posix.join(realTarget, posix.basename(lexical));
    const roots = await this.realRoots();
    if (!roots.some((r) => isInside(real, r))) {
      throw new PathJailError(`path resolves outside allowed roots: ${input}`);
    }
    return { lexical, real };
  }

  /** realpath of the deepest existing ancestor, plus the not-yet-existing remainder. */
  private async realpathExisting(p: string): Promise<string> {
    const rest: string[] = [];
    let cur = p;
    for (;;) {
      const real = await this.deps.realpath(cur);
      if (real !== null) return clean(posix.join(real, ...rest));
      if (cur === '/') return p;
      rest.unshift(posix.basename(cur));
      cur = posix.dirname(cur);
    }
  }
}
