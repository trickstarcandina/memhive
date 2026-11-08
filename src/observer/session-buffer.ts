export interface ToolEvent {
  name: string;
  input: unknown;
  output?: unknown;
  failed?: boolean;
  at: string;
}

export class SessionBuffer {
  private events: ToolEvent[] = [];
  constructor(
    private maxEvents: number,
    private maxAgeMs: number
  ) {}
  push(ev: ToolEvent, now = Date.now()): void {
    this.expire(now);
    this.events.push(ev);
    while (this.events.length > this.maxEvents) this.events.shift();
  }
  expire(now = Date.now()): void {
    this.events = this.events.filter((e) => now - Date.parse(e.at) <= this.maxAgeMs);
  }
  size(now = Date.now()): number {
    this.expire(now);
    return this.events.length;
  }
  drain(now = Date.now()): ToolEvent[] {
    this.expire(now);
    const out = this.events;
    this.events = [];
    return out;
  }
}
