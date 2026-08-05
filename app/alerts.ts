/**
 * Match alerts.
 *
 * These fire while the page is open, including when its tab is backgrounded or
 * the window is minimised. They cannot fire once the browser is closed: that
 * needs a server doing the scanning, and Binance rejects datacenter IPs.
 */

export type AlertPermission = "unsupported" | "default" | "granted" | "denied";

export const ALERTS_STORAGE_KEY = "coin-hunt:alerts-enabled";

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

export function loadPreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ALERTS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function savePreference(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ALERTS_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Private mode and blocked storage are not worth failing the toggle over.
  }
}

/** Short chime, synthesised so the build carries no audio asset. */
export function chime() {
  if (typeof window === "undefined") return;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  try {
    const context = new Ctor();
    const play = (frequency: number, startAt: number) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      const start = context.currentTime + startAt;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
      oscillator.start(start);
      oscillator.stop(start + 0.32);
    };
    play(784, 0);
    play(1175, 0.12);
    window.setTimeout(() => void context.close(), 900);
  } catch {
    // Autoplay policy can still refuse before the first interaction.
  }
}

export function notifyMatches(symbols: string[], context: string, tag: string) {
  if (typeof window === "undefined" || readPermission() !== "granted" || !symbols.length) return;
  const shown = symbols.slice(0, 6).join(", ");
  const extra = symbols.length > 6 ? ` +${symbols.length - 6} more` : "";
  try {
    const notification = new Notification(
      `${symbols.length} exact match${symbols.length === 1 ? "" : "es"} — ${context}`,
      {
        body: `${shown}${extra}`,
        // One notification per page, so repeated scans replace rather than pile up.
        tag,
        renotify: true,
        icon: "/coin-hunt/favicon.svg",
      } as NotificationOptions,
    );
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Some browsers throw when constructing notifications outside a worker.
  }
}
