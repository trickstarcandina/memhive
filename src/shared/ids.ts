import { v7 as uuidv7 } from 'uuid';
export const newId = (): string => uuidv7();
// Random tail: the head of a UUIDv7 is a timestamp, so head prefixes collide for ids created close together.
export function shortId(id: string): string {
  return id.slice(-8);
}
