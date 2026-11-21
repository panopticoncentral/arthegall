import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { calendarDay, DateRange, type SourceUsage, type UsageReport, zone } from '../../../packages/contracts/src/reporting.js';

const tokens = z.number().int().nonnegative();
const codexRecord = z.object({
  response_id: z.string().min(1),
  usage: z.object({ input_tokens: tokens, output_tokens: tokens, total_tokens: tokens,
    cached_input_tokens: tokens.nullish(), reasoning_output_tokens: tokens.nullish() }),
});
const claudeRecord = z.object({
  id: z.string().min(1), model: z.string().min(1),
  usage: z.object({ input_tokens: tokens, output_tokens: tokens, cache_read_input_tokens: tokens, cache_creation_input_tokens: tokens }),
});
type Counts = { input: number; output: number; cachedInput: number | null; reasoningOutput: number | null };
type Source = 'codex' | 'claude';

async function sourceUsage(source: Source, roots: string[], range: DateRange): Promise<SourceUsage> {
  const responses = new Map<string, { day: string; counts: Counts }>();
  const conflicts = new Map<string, boolean>();
  const inRange = (day: string) => day >= range.start && day <= range.end;
  const notes = new Set<string>();
  let incomplete = false;
  function partial(reason: string) { incomplete = true; notes.add(reason); }
  function observe(id: string, day: string, counts: Counts) {
    if (conflicts.has(id)) {
      if (inRange(day)) conflicts.set(id, true);
      return;
    }
    const previous = responses.get(id);
    if (previous && JSON.stringify(previous.counts) !== JSON.stringify(counts)) {
      responses.delete(id);
      conflicts.set(id, inRange(previous.day) || inRange(day));
    } else if (!previous || previous.day > day) {
      // Copied records can appear later in another rollout. Attribute the
      // response to its earliest observed day, even outside this request.
      responses.set(id, { day, counts });
    }
  }
  async function read(path: string) {
    let tokenEvent = false, comparableEvents = false, tokenEventTotal = 0;
    let previousCumulative: number | undefined;
    const dailyResponses = new Map<string, number>();
    const stream = createReadStream(path, { encoding: 'utf8' });
    try {
      for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); }
        catch { partial('Some local records could not be parsed.'); continue; }
        if (!row || typeof row !== 'object') { partial('Unrecognized local record.'); continue; }
        const tokenCount = row.type === 'event_msg' && row.payload?.type === 'token_count' && row.payload.info;
        if (source === 'codex' ? row.type !== 'token_usage_record' && !tokenCount : row.type !== 'assistant') continue;
        if (typeof row.timestamp !== 'string' || !/(Z|[+-]\d\d:\d\d)$/i.test(row.timestamp) || !Number.isFinite(Date.parse(row.timestamp))) {
          partial('Some usage timestamps were unavailable.'); continue;
        }
        const day = calendarDay(new Date(row.timestamp));
        if (tokenCount) {
          const cumulative = tokenCount.total_token_usage?.total_tokens;
          const last = tokenCount.last_token_usage?.total_tokens;
          if (inRange(day)) {
            tokenEvent = true;
            if (Number.isSafeInteger(cumulative) && Number.isSafeInteger(last)) {
              comparableEvents = true;
              if (cumulative !== previousCumulative) tokenEventTotal += last;
            }
          }
          previousCumulative = cumulative;
          continue;
        }
        if (source === 'codex') {
          const parsed = codexRecord.safeParse(row.payload);
          if (!parsed.success) { if (inRange(day)) partial('Some responses lacked an identity or usable token fields.'); continue; }
          const { response_id, usage: u } = parsed.data;
          if (u.total_tokens !== u.input_tokens + u.output_tokens || (u.cached_input_tokens ?? 0) > u.input_tokens || (u.reasoning_output_tokens ?? 0) > u.output_tokens) {
            if (inRange(day)) partial('Inconsistent token totals were excluded.'); continue;
          }
          if (inRange(day)) dailyResponses.set(response_id, u.total_tokens);
          observe(response_id, day, { input: u.input_tokens, output: u.output_tokens, cachedInput: u.cached_input_tokens ?? null, reasoningOutput: u.reasoning_output_tokens ?? null });
        } else {
          if (row.message?.model === '<synthetic>') continue;
          const parsed = claudeRecord.safeParse(row.message);
          if (!parsed.success) { if (inRange(day)) partial('Some assistant messages lacked complete response usage.'); continue; }
          const { id, usage: u } = parsed.data;
          observe(id, day, { input: u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens,
            output: u.output_tokens, cachedInput: u.cache_read_input_tokens, reasoningOutput: null });
        }
      }
      const responseTotal = [...dailyResponses.values()].reduce((sum, n) => sum + n, 0);
      if (comparableEvents && dailyResponses.size && responseTotal !== tokenEventTotal)
        partial('A session’s token-count cross-check differed. Totals include only distinct response records.');
      if (tokenEvent && !dailyResponses.size) partial('A session had token-count events without distinct response records for the range.');
    } finally { stream.destroy(); }
  }
  async function walk(directory: string, root = false) {
    try {
      if (!(await lstat(directory)).isDirectory()) { partial('A source directory was unavailable.'); return; }
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          try { await read(path); } catch { partial('A local session file could not be read.'); }
        } else if (entry.isSymbolicLink()) partial('Linked sources were excluded.');
      }
    } catch (e) {
      if (!root || (e as NodeJS.ErrnoException).code !== 'ENOENT') partial('A source directory could not be read.');
    }
  }
  for (const root of roots) await walk(root, true);
  for (const [id, record] of responses) if (!inRange(record.day)) responses.delete(id);
  if ([...conflicts.values()].includes(true)) partial('Conflicting copies of a response were excluded.');
  if (source === 'claude' && responses.size) partial('Claude activity-day coverage is unverified. Counts cover recognized assistant message usage only.');
  if (!responses.size) notes.add('No countable local responses found in the date range. Usage is unknown.');
  notes.add('Actual spend unavailable from these records.');
  function sum(key: keyof Counts) {
    if (!responses.size) return null;
    let total = 0;
    for (const { counts } of responses.values()) {
      if (counts[key] === null) return null;
      total += counts[key];
    }
    return total;
  }
  const input = sum('input'), output = sum('output');
  return { coverage: incomplete ? 'partial' : responses.size ? 'recorded' : 'no_records', responses: responses.size,
    input, output, total: input !== null && output !== null ? input + output : null,
    cachedInput: sum('cachedInput'), reasoningOutput: sum('reasoningOutput'), actualSpendUsd: null, notes: [...notes] };
}

export async function readUsage(input: DateRange, roots = {
  codex: process.env.ARTHEGALL_CODEX_USAGE_DIR ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  claude: process.env.ARTHEGALL_CLAUDE_USAGE_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
}): Promise<UsageReport> {
  const range = DateRange.parse(input);
  const [codex, claude] = await Promise.all([
    sourceUsage('codex', ['sessions', 'archived_sessions'].map((name) => join(roots.codex, name)), range),
    sourceUsage('claude', [join(roots.claude, 'projects')], range),
  ]);
  return { range, timeZone: zone, codex, claude, combinedTokens: null, combinedActualSpendUsd: null };
}
