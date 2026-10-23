import { chromium, type BrowserContext } from 'playwright-core';

export interface BrowserOptions {
  profileDir: string;
  headless?: boolean;
  /** Playwright channel; defaults to the locally installed Google Chrome. */
  channel?: string;
  executablePath?: string;
  proxy?: { server: string; bypass?: string };
  ignoreHTTPSErrors?: boolean;
  locale?: string;
  timezoneId?: string;
  recordHarPath?: string;
  /** Record a video of every page (tab) into this directory; saved when the page closes. */
  recordVideo?: { dir: string; size?: { width: number; height: number } };
  /** Expose CDP on this port so an external agent can drive the same browser. */
  cdpPort?: number;
  args?: string[];
}

/** A dedicated, persistent Chrome profile; service workers blocked so every request hits the network. */
export async function launchBrowser(o: BrowserOptions): Promise<BrowserContext> {
  const args = [
    '--disable-quic',
    '--no-first-run',
    '--no-default-browser-check',
    // keep Chrome's own background traffic (sync, autofill, updates) out of recordings and replays
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-domain-reliability',
    '--disable-client-side-phishing-detection',
    '--disable-features=AutofillServerCommunication,OptimizationHints,MediaRouter,Translate,InterestFeedContentSuggestions',
    ...(o.args ?? []),
  ];
  if (o.cdpPort) args.push(`--remote-debugging-port=${o.cdpPort}`);
  return chromium.launchPersistentContext(o.profileDir, {
    channel: o.executablePath ? undefined : o.channel ?? 'chrome',
    executablePath: o.executablePath,
    headless: o.headless ?? false,
    proxy: o.proxy,
    ignoreHTTPSErrors: o.ignoreHTTPSErrors,
    locale: o.locale,
    timezoneId: o.timezoneId,
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
    recordHar: o.recordHarPath ? { path: o.recordHarPath, content: 'embed', mode: 'full' } : undefined,
    recordVideo: o.recordVideo,
    args,
  });
}
