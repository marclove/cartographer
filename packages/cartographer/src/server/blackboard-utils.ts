export function blackboardToRecord(bb: { keys(): string[]; get<T>(key: string): T | undefined; toRecord?(): Record<string, unknown> }): Record<string, unknown> {
  if (typeof bb.toRecord === 'function') {
    return bb.toRecord();
  }
  const record: Record<string, unknown> = {};
  for (const key of bb.keys()) {
    record[key] = bb.get(key);
  }
  return record;
}
