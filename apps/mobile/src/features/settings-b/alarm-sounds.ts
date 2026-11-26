import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import type { AudioSource } from 'expo-audio';

/** Tones an alarm can use (originals bundled in assets/sounds). */
export interface AlarmSound {
  readonly id: string;
  readonly name: string;
  readonly source: AudioSource;
}

export const ALARM_SOUNDS: readonly AlarmSound[] = [
  { id: 'urgent', name: 'Urgent', source: require('@/assets/sounds/urgent.wav') },
  { id: 'beacon', name: 'Beacon', source: require('@/assets/sounds/beacon.wav') },
  { id: 'pulse', name: 'Pulse', source: require('@/assets/sounds/pulse.wav') },
  { id: 'siren', name: 'Siren', source: require('@/assets/sounds/siren.wav') },
  { id: 'rise', name: 'Rise', source: require('@/assets/sounds/rise.wav') },
  { id: 'fall', name: 'Fall', source: require('@/assets/sounds/fall.wav') },
  { id: 'chime', name: 'Chime', source: require('@/assets/sounds/chime.wav') },
  { id: 'ticktock', name: 'Tick Tock', source: require('@/assets/sounds/ticktock.wav') },
];

export const soundName = (id: string): string => ALARM_SOUNDS.find((s) => s.id === id)?.name ?? ALARM_SOUNDS[0]!.name;

/** SoundPreviewPlayer: plays one tone at a time for auditioning in the picker. */
export class TonePreview {
  private player: AudioPlayer | null = null;
  private current: string | null = null;
  private listener: (() => void) | null = null;

  constructor(private readonly onChange: (playing: string | null) => void) {}

  get playing(): string | null {
    return this.current;
  }

  toggle(id: string): void {
    if (this.current === id) this.stop();
    else this.play(id);
  }

  play(id: string): void {
    const sound = ALARM_SOUNDS.find((s) => s.id === id);
    if (!sound) return;
    this.stop();
    void setAudioModeAsync({ playsInSilentMode: false, interruptionMode: 'duckOthers' }).catch(() => undefined);
    try {
      const player = createAudioPlayer(sound.source);
      const sub = player.addListener('playbackStatusUpdate', (status) => {
        if (status.didJustFinish && this.player === player) this.stop();
      });
      this.listener = () => sub.remove();
      this.player = player;
      this.current = id;
      this.onChange(id);
      player.play();
    } catch {
      this.stop();
    }
  }

  stop(): void {
    const player = this.player;
    this.player = null;
    this.current = null;
    this.listener?.();
    this.listener = null;
    if (player) {
      try {
        player.pause();
        player.remove();
      } catch {
        // already released
      }
    }
    this.onChange(null);
  }
}
