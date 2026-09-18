// What the update strip says, given the build that runs and the build that
// waits. Kept apart from the component so the wording is testable: the
// waiting build may be unknown (the version file did not load), and two
// builds may share a version number (the dev site between tags), in which
// case the commits tell them apart.

export type BuildInfo = { version: string; commit: string };

export type UpdateWording = {
  headline: string;
  current: string;
  /** Commit range for a compare page, or null when either commit is unknown. */
  compare: string | null;
};

export function updateWording(running: BuildInfo, waiting: BuildInfo | null): UpdateWording {
  // A commit goes into a link, and the waiting one comes from the host: only
  // what looks like a commit is used.
  const known = (c: string) => /^[0-9a-f]{7,40}$/.test(c);
  if (!waiting) {
    return { headline: 'A new version of Neptune Vault is ready', current: `You are on ${running.version} (${running.commit})`, compare: null };
  }
  const sameVersion = waiting.version === running.version;
  const compare = known(running.commit) && known(waiting.commit) && running.commit !== waiting.commit ? `${running.commit}...${waiting.commit}` : null;
  return {
    headline: sameVersion ? `Version ${waiting.version} (${waiting.commit}) is ready` : `Version ${waiting.version} is ready`,
    current: sameVersion ? `You are on ${running.version} (${running.commit})` : `You are on ${running.version}`,
    compare,
  };
}

/** Reads the build the host serves now; null when it cannot be read. */
export async function fetchWaitingBuild(): Promise<BuildInfo | null> {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<BuildInfo>;
    if (typeof body.version !== 'string' || typeof body.commit !== 'string') return null;
    return { version: body.version, commit: body.commit };
  } catch {
    return null;
  }
}
