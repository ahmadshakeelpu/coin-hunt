/**
 * Match alerts.
 *
 * These fire while the page is open, including when its tab is backgrounded or
 * the window is minimised. They cannot fire once the browser is closed: that
 * needs a server doing the scanning, and Binance rejects datacenter IPs.
 */

export type AlertPermission = "unsupported" | "default" | "granted" | "denied";
export type AlertTone = "bullish" | "bearish";

export type AlertEvent = {
  id: string;
  symbols: string[];
  context: string;
  tone: AlertTone;
  at: number;
};

export const ALERTS_STORAGE_KEY = "coin-hunt:alerts-enabled";
export const SOUND_STORAGE_KEY = "coin-hunt:alerts-sound";

export function readPermission(): AlertPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission as AlertPermission;
}

/** Must be called from a user gesture or browsers reject the prompt. */
export async function requestPermission(): Promise<AlertPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission as AlertPermission;
  try {
    return (await Notification.requestPermission()) as AlertPermission;
  } catch {
    return "denied";
  }
}

const readFlag = (key: string, fallback: boolean) => {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem(key);
    return stored === null ? fallback : stored === "1";
  } catch {
    return fallback;
  }
};

const writeFlag = (key: string, value: boolean) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Private mode and blocked storage are not worth failing a toggle over.
  }
};

export const loadPreference = () => readFlag(ALERTS_STORAGE_KEY, false);
export const savePreference = (enabled: boolean) => writeFlag(ALERTS_STORAGE_KEY, enabled);
export const loadSoundPreference = () => readFlag(SOUND_STORAGE_KEY, true);
export const saveSoundPreference = (enabled: boolean) => writeFlag(SOUND_STORAGE_KEY, enabled);

/**
 * One AudioContext for the page. Browsers cap how many can exist, and creating
 * one per alert eventually throws and kills the sound entirely.
 */
let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    audioContext ??= new Ctor();
    // Autoplay policy suspends contexts created before the first interaction.
    if (audioContext.state === "suspended") void audioContext.resume();
    return audioContext;
  } catch {
    return null;
  }
}

// Rising major arpeggio for bullish, falling minor for bearish, so the two
// pages are distinguishable without looking at the screen.
const TONES: Record<AlertTone, number[]> = {
  bullish: [587.33, 739.99, 880, 1174.66],
  bearish: [493.88, 415.3, 349.23, 261.63],
};

/** Synthesised so the build carries no audio asset. */
export function chime(tone: AlertTone = "bullish") {
  const context = getAudioContext();
  if (!context) return;
  try {
    const now = context.currentTime;
    // A shared gentle low-pass keeps the stacked sines from sounding harsh.
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 2600;
    filter.connect(context.destination);

    TONES[tone].forEach((frequency, index) => {
      const start = now + index * 0.085;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = index === TONES[tone].length - 1 ? "triangle" : "sine";
      oscillator.frequency.setValueAtTime(frequency, start);
      // Exponential ramps avoid the click a linear cut to zero produces.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.24, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.42);
      oscillator.connect(gain);
      gain.connect(filter);
      oscillator.start(start);
      oscillator.stop(start + 0.45);
    });
  } catch {
    // Autoplay policy can still refuse before the first interaction.
  }
}

export type NotifyDetail = { symbol: string; price: string; rsi1h: number; rsi30m: number };

export function notifyMatches(matches: NotifyDetail[], context: string, tag: string) {
  if (typeof window === "undefined" || readPermission() !== "granted" || !matches.length) return;
  const headline = `${matches.length} exact match${matches.length === 1 ? "" : "es"} · ${context}`;
  const lines = matches
    .slice(0, 4)
    .map((m) => `${m.symbol}  ${m.price}  RSI ${m.rsi1h.toFixed(1)}/${m.rsi30m.toFixed(1)}`);
  if (matches.length > 4) lines.push(`+${matches.length - 4} more`);
  try {
    const notification = new Notification(headline, {
      body: lines.join("\n"),
      // One notification per page, so repeated scans replace rather than pile up.
      tag,
      renotify: true,
      requireInteraction: true,
      icon: "/coin-hunt/favicon.svg",
              badge: "/coin-hunt/favicon.svg",
    } as NotificationOptions);
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Some browsers throw when constructing notifications outside a worker.
  }
}
